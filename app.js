
/**
 * Dessert Cost Calculator — multi-recipe profiles + persistent storage
 *
 * Storage strategy:
 * - Per-recipe FULL rows (name,cost,amount,recipeAmount) in localStorage (fast switching + keeps costs).
 * - Ingredient cache in localStorage so costs/amounts can be reused by ingredient name.
 * - Profiles database (IndexedDB) stores ONLY: { recipeName, Ingredient, RecipeAmmount } as requested.
 */

const CURRENT_RECIPE_KEY = "dessert_current_recipe_v1";
const ROWS_KEY_PREFIX    = "dessert_rows__v1__";            // + recipeName
const ING_CACHE_KEY      = "dessert_ingredient_cache_v1";   // { [Ingredient]: {cost, amount} }
const MARGIN_KEY         = "dessert_margin_pct_v1";

// IndexedDB (profiles)
const DB_NAME = "dessert_profiles_db_v1";
const DB_VER  = 1;
const STORE_ITEMS = "recipe_items"; // key = `${recipeName}::${Ingredient}`

function n(v){
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(",", ".");
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}

function money(v){
  const x = Math.round(v * 100) / 100;
  return "$" + x.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function moneyInt(v){
  const x = Math.round(v);
  return "$" + x.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function defaultRows(){
  return [
    { name:"Flour", cost:1290, amount:1000, recipeAmount:300 },
    { name:"Sugar", cost:0, amount:0, recipeAmount:0 },
  ];
}

function getRowsKey(recipeName){
  return ROWS_KEY_PREFIX + recipeName;
}

function getCurrentRecipe(){
  const s = (localStorage.getItem(CURRENT_RECIPE_KEY) || "").trim();
  return s || "Default";
}

function setCurrentRecipe(name){
  localStorage.setItem(CURRENT_RECIPE_KEY, name);
}

function loadMarginPct(){
  const raw = localStorage.getItem(MARGIN_KEY);
  const val = (raw === null) ? 30 : n(raw);
  return Number.isFinite(val) ? val : 30;
}

function saveMarginPct(v){
  localStorage.setItem(MARGIN_KEY, String(v));
}

function loadIngredientCache(){
  try{
    const raw = localStorage.getItem(ING_CACHE_KEY);
    if(!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  }catch{
    return {};
  }
}

function saveIngredientCache(cache){
  localStorage.setItem(ING_CACHE_KEY, JSON.stringify(cache));
}

function loadRowsForRecipe(recipeName){
  try{
    const raw = localStorage.getItem(getRowsKey(recipeName));
    if(!raw) return null;
    const rows = JSON.parse(raw);
    if(!Array.isArray(rows)) return null;
    return rows.map(r => ({
      name: r.name ?? "",
      cost: n(r.cost),
      amount: n(r.amount),
      recipeAmount: n(r.recipeAmount),
    }));
  }catch{
    return null;
  }
}

function saveRowsForRecipe(recipeName, rows){
  localStorage.setItem(getRowsKey(recipeName), JSON.stringify(rows));
}

function computeRow(r){
  const unit = (r.amount > 0) ? (r.cost / r.amount) : 0;
  const recipeCost = unit * r.recipeAmount;
  return { unit, recipeCost };
}

function buildRowHTML(r, idx){
  const { unit, recipeCost } = computeRow(r);
  return `
    <tr data-row="${idx}">
      <td><input data-k="name" data-i="${idx}" value="${escapeHtml(r.name)}" placeholder="e.g., Flour" /></td>

      <td><input data-k="cost" data-i="${idx}" inputmode="decimal" value="${r.cost || ""}" placeholder="0" /></td>
      <td><input data-k="amount" data-i="${idx}" inputmode="decimal" value="${r.amount || ""}" placeholder="0" /></td>

      <td class="readonly" data-out="unit" data-i="${idx}">${money(unit)}</td>

      <td><input data-k="recipeAmount" data-i="${idx}" inputmode="decimal" value="${r.recipeAmount || ""}" placeholder="0" /></td>

      <td class="readonly" data-out="recipeCost" data-i="${idx}">${money(recipeCost)}</td>

      <td><button class="btn btn-danger" type="button" data-del="${idx}">Delete</button></td>
    </tr>
  `;
}

function updateComputedForIndex(rows, idx){
  const r = rows[idx];
  if (!r) return;

  const { unit, recipeCost } = computeRow(r);

  const unitCell = document.querySelector(`[data-out="unit"][data-i="${idx}"]`);
  const recipeCell = document.querySelector(`[data-out="recipeCost"][data-i="${idx}"]`);
  if (unitCell) unitCell.textContent = money(unit);
  if (recipeCell) recipeCell.textContent = money(recipeCost);
}

function computeTotal(rows){
  let total = 0;
  for (const r of rows){
    total += computeRow(r).recipeCost;
  }
  return total;
}

function updateTotalAndPricing(rows){
  const total = computeTotal(rows);
  document.getElementById("totalCell").textContent = money(total);

  const marginPct = n(document.getElementById("marginPct").value);
  const finalPrice = Math.round(total * (1 + marginPct / 100));
  document.getElementById("finalPriceCell").textContent = moneyInt(finalPrice);
}

function renumberDOMIndices(){
  const trs = document.querySelectorAll("#tbody tr");
  trs.forEach((tr, newIdx) => {
    tr.dataset.row = String(newIdx);

    tr.querySelectorAll("[data-i]").forEach(el => el.dataset.i = String(newIdx));
    tr.querySelectorAll("[data-del]").forEach(el => el.dataset.del = String(newIdx));
  });
}

/* =========================
   IndexedDB helpers
   ========================= */
function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)){
        db.createObjectStore(STORE_ITEMS, { keyPath: "key" });
      }
      // Note: we intentionally keep only "Ingredient" and "RecipeAmmount" as data fields.
      // recipeName is only used as part of the key + as a filter attribute for listing.
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutItems(db, recipeName, rows){
  // Store ONLY {Ingredient, RecipeAmmount} per ingredient; recipeName is embedded in key and also stored for queries.
  // Key format: `${recipeName}::${Ingredient}`
  const tx = db.transaction(STORE_ITEMS, "readwrite");
  const store = tx.objectStore(STORE_ITEMS);

  // First: delete existing items for recipe
  const existing = await dbGetItems(db, recipeName);
  for (const it of existing){
    store.delete(it.key);
  }

  for (const r of rows){
    const Ingredient = String(r.name || "").trim();
    if (!Ingredient) continue;
    const RecipeAmmount = n(r.recipeAmount);
    const key = `${recipeName}::${Ingredient}`;
    store.put({ key, recipeName, Ingredient, RecipeAmmount });
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function dbGetAll(db){
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ITEMS, "readonly");
    const store = tx.objectStore(STORE_ITEMS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetItems(db, recipeName){
  const all = await dbGetAll(db);
  return all.filter(x => x && x.recipeName === recipeName);
}

async function dbListRecipes(db){
  const all = await dbGetAll(db);
  const set = new Set();
  for (const it of all){
    if (it && typeof it.recipeName === "string" && it.recipeName.trim()){
      set.add(it.recipeName);
    }
  }
  // Always include Default
  set.add("Default");
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

async function dbDeleteRecipe(db, recipeName){
  const tx = db.transaction(STORE_ITEMS, "readwrite");
  const store = tx.objectStore(STORE_ITEMS);

  const all = await dbGetItems(db, recipeName);
  for (const it of all){
    store.delete(it.key);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* =========================
   App state
   ========================= */
let DB = null;
let currentRecipe = getCurrentRecipe();
let rowsState = null;

// ---- Debounce para no escribir localStorage a cada tecla
let saveTimer = null;
function scheduleSave(){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveRowsForRecipe(currentRecipe, rowsState);
  }, 250);
}

function setRecipeTitle(){
  const el = document.getElementById("recipeTitle");
  el.textContent = currentRecipe;
}

function closeDrawer(){
  document.body.classList.remove("drawer-open");
}
function openDrawer(){
  document.body.classList.add("drawer-open");
}

function renderRecipeList(recipeNames){
  const list = document.getElementById("recipeList");
  list.innerHTML = "";

  for (const name of recipeNames){
    const div = document.createElement("div");
    div.className = "recipeItem" + (name === currentRecipe ? " active" : "");
    div.setAttribute("role", "listitem");

    const left = document.createElement("div");
    left.style.minWidth = "0";
    left.innerHTML = `<div class="recipeName">${escapeHtml(name)}</div><div class="pill">open</div>`;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    right.style.alignItems = "center";

    const delBtn = document.createElement("button");
    delBtn.className = "iconBtn danger";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.title = "Delete recipe";
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (name === "Default"){
        // Don't delete Default, just clear it
        localStorage.removeItem(getRowsKey("Default"));
        await dbDeleteRecipe(DB, "Default");
        if (currentRecipe === "Default"){
          await switchRecipe("Default", true);
        }
        await refreshRecipesUI();
        return;
      }
      localStorage.removeItem(getRowsKey(name));
      await dbDeleteRecipe(DB, name);
      if (currentRecipe === name){
        await switchRecipe("Default", true);
      }
      await refreshRecipesUI();
    });

    right.appendChild(delBtn);

    div.appendChild(left);
    div.appendChild(right);

    div.addEventListener("click", async () => {
      await switchRecipe(name, true);
      closeDrawer();
      await refreshRecipesUI();
    });

    list.appendChild(div);
  }
}

async function refreshRecipesUI(){
  if (!DB) return;
  const names = await dbListRecipes(DB);

  // Also include recipes that exist only in localStorage (full rows) even if not saved to DB yet.
  // This helps when you create + edit before pressing "Save".
  const lsNames = new Set(names);
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.startsWith(ROWS_KEY_PREFIX)){
      const rn = k.slice(ROWS_KEY_PREFIX.length);
      if (rn) lsNames.add(rn);
    }
  }
  const merged = Array.from(lsNames).sort((a,b)=>a.localeCompare(b));
  renderRecipeList(merged);
}

function initialTableRender(){
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = rowsState.map((r, i) => buildRowHTML(r, i)).join("");
  updateTotalAndPricing(rowsState);
}

function updateIngredientCacheFromRows(rows){
  const cache = loadIngredientCache();
  for (const r of rows){
    const name = String(r.name || "").trim();
    if (!name) continue;
    // If cost/amount exist, cache them (lets you reuse without retyping)
    if (r.cost > 0 || r.amount > 0){
      cache[name] = { cost: n(r.cost), amount: n(r.amount) };
    }
  }
  saveIngredientCache(cache);
}

async function ensureRowsForRecipe(recipeName){
  // 1) Try full rows from localStorage for that recipe
  const fromLS = loadRowsForRecipe(recipeName);
  if (fromLS) return fromLS;

  // 2) Else, build rows from DB (Ingredient + RecipeAmmount) + ingredient cache for cost/amount
  if (DB){
    const items = await dbGetItems(DB, recipeName);
    if (items.length){
      const cache = loadIngredientCache();
      const built = items.map(it => {
        const c = cache[it.Ingredient] || { cost: 0, amount: 0 };
        return {
          name: it.Ingredient,
          cost: n(c.cost),
          amount: n(c.amount),
          recipeAmount: n(it.RecipeAmmount),
        };
      });
      return built.length ? built : defaultRows();
    }
  }

  // 3) fallback
  return defaultRows();
}

async function switchRecipe(recipeName, persist){
  currentRecipe = recipeName;
  if (persist) setCurrentRecipe(recipeName);

  rowsState = await ensureRowsForRecipe(recipeName);
  saveRowsForRecipe(recipeName, rowsState); // keep full copy
  setRecipeTitle();
  initialTableRender();
}

/* =========================
   Events
   ========================= */

// Drawer controls
document.getElementById("openDrawerBtn").addEventListener("click", () => openDrawer());
document.getElementById("closeDrawerBtn").addEventListener("click", () => closeDrawer());
document.getElementById("drawerOverlay").addEventListener("click", () => closeDrawer());

// Create recipe
document.getElementById("createRecipeBtn").addEventListener("click", async () => {
  const input = document.getElementById("newRecipeName");
  const name = String(input.value || "").trim();
  if (!name) return;

  // Switch to new recipe with default rows (and save immediately in localStorage)
  await switchRecipe(name, true);
  saveRowsForRecipe(name, rowsState);
  input.value = "";
  await refreshRecipesUI();
});

// Save recipe profile to IndexedDB (Ingredient + RecipeAmmount)
document.getElementById("saveRecipeBtn").addEventListener("click", async () => {
  if (!DB) return;

  updateIngredientCacheFromRows(rowsState); // helps "don't retype"
  await dbPutItems(DB, currentRecipe, rowsState);
  await refreshRecipesUI();
});

// Margin input
document.getElementById("marginPct").addEventListener("input", (e) => {
  const v = n(e.target.value);
  saveMarginPct(v);
  updateTotalAndPricing(rowsState);
});

// Table input (event delegation)
document.getElementById("tbody").addEventListener("input", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;

  const k = t.dataset.k;
  const i = Number(t.dataset.i);
  if (!k || !Number.isFinite(i)) return;

  if (!rowsState[i]) return;

  if (k === "name") rowsState[i].name = t.value;
  if (k === "cost") rowsState[i].cost = n(t.value);
  if (k === "amount") rowsState[i].amount = n(t.value);
  if (k === "recipeAmount") rowsState[i].recipeAmount = n(t.value);

  updateComputedForIndex(rowsState, i);
  updateTotalAndPricing(rowsState);

  // Keep full rows + ingredient cache
  scheduleSave();
  updateIngredientCacheFromRows(rowsState);
});

document.getElementById("tbody").addEventListener("click", (e) => {
  const btn = e.target;
  if (!(btn instanceof HTMLElement)) return;

  const del = btn.getAttribute("data-del");
  if (del === null) return;

  const idx = Number(del);
  if (!Number.isFinite(idx)) return;

  rowsState.splice(idx, 1);

  // Remueve la fila del DOM sin re-render total
  const tr = document.querySelector(`#tbody tr[data-row="${idx}"]`);
  if (tr) tr.remove();

  // Si quedó vacío, vuelve a default
  if (!rowsState.length){
    rowsState = defaultRows();
    saveRowsForRecipe(currentRecipe, rowsState);
    initialTableRender();
    scheduleSave();
    updateIngredientCacheFromRows(rowsState);
    return;
  }

  renumberDOMIndices();
  saveRowsForRecipe(currentRecipe, rowsState);
  updateTotalAndPricing(rowsState);
  scheduleSave();
});

document.getElementById("addRowBtn").addEventListener("click", () => {
  rowsState.push({ name:"", cost:0, amount:0, recipeAmount:0 });
  saveRowsForRecipe(currentRecipe, rowsState);

  const tbody = document.getElementById("tbody");
  const idx = rowsState.length - 1;

  tbody.insertAdjacentHTML("beforeend", buildRowHTML(rowsState[idx], idx));
  updateTotalAndPricing(rowsState);

  const nameInput = tbody.querySelector(`input[data-k="name"][data-i="${idx}"]`);
  if (nameInput) nameInput.focus();

  scheduleSave();
});

document.getElementById("resetBtn").addEventListener("click", () => {
  rowsState = defaultRows();
  saveRowsForRecipe(currentRecipe, rowsState);
  initialTableRender();
  scheduleSave();
  updateIngredientCacheFromRows(rowsState);
});

/* =========================
   Boot
   ========================= */
(async function boot(){
  // Set margin initial value
  const marginEl = document.getElementById("marginPct");
  marginEl.value = String(loadMarginPct());

  // Open DB
  try{
    DB = await openDB();
  }catch{
    DB = null; // still works without profiles DB
  }

  // Load current recipe
  currentRecipe = getCurrentRecipe();
  rowsState = await ensureRowsForRecipe(currentRecipe);

  // Ensure full rows stored (per recipe)
  saveRowsForRecipe(currentRecipe, rowsState);

  setRecipeTitle();
  initialTableRender();

  if (DB){
    await refreshRecipesUI();
  }else{
    // Still show Default recipe in list if DB not available
    renderRecipeList(["Default"]);
  }
})();
