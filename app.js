/**
 * Dessert Cost Calculator — multi-recipe + persistent profiles (IndexedDB)
 * iOS/Safari safe: no await inside IDB transactions + robust DOM boot
 */

const CURRENT_RECIPE_KEY = "dessert_current_recipe_v1";
const ROWS_KEY_PREFIX    = "dessert_rows__v1__";            // + recipeName
const ING_CACHE_KEY      = "dessert_ingredient_cache_v1";   // { [Ingredient]: {cost, amount} }
const MARGIN_KEY         = "dessert_margin_pct_v1";

// IndexedDB (profiles)
const DB_NAME = "dessert_profiles_db_v1";
const DB_VER  = 1;
const STORE_ITEMS = "recipe_items"; // key = `${recipeName}::${Ingredient}`

// ---------------- Helpers ----------------
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

function computeTotal(rows){
  let total = 0;
  for (const r of rows){
    total += computeRow(r).recipeCost;
  }
  return total;
}

// ---------------- IndexedDB ----------------
function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)){
        db.createObjectStore(STORE_ITEMS, { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

async function dbPutItems(db, recipeName, rows){
  // IMPORTANT (iOS/Safari): never await while tx is open
  const existing = await dbGetItems(db, recipeName);

  const tx = db.transaction(STORE_ITEMS, "readwrite");
  const store = tx.objectStore(STORE_ITEMS);

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

async function dbDeleteRecipe(db, recipeName){
  // IMPORTANT (iOS/Safari): never await while tx is open
  const existing = await dbGetItems(db, recipeName);

  const tx = db.transaction(STORE_ITEMS, "readwrite");
  const store = tx.objectStore(STORE_ITEMS);

  for (const it of existing){
    store.delete(it.key);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------- App state ----------------
let DB = null;
let currentRecipe = getCurrentRecipe();
let rowsState = null;

// debounce save
let saveTimer = null;
function scheduleSave(){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveRowsForRecipe(currentRecipe, rowsState);
  }, 250);
}

function openDrawer(){ document.body.classList.add("drawer-open"); }
function closeDrawer(){ document.body.classList.remove("drawer-open"); }

function setRecipeTitle(){
  const el = document.getElementById("recipeTitle");
  if (el) el.textContent = currentRecipe;
}

function updateIngredientCacheFromRows(rows){
  const cache = loadIngredientCache();
  for (const r of rows){
    const name = String(r.name || "").trim();
    if (!name) continue;
    if (r.cost > 0 || r.amount > 0){
      cache[name] = { cost: n(r.cost), amount: n(r.amount) };
    }
  }
  saveIngredientCache(cache);
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

function updateTotalAndPricing(rows){
  const total = computeTotal(rows);
  const totalCell = document.getElementById("totalCell");
  if (totalCell) totalCell.textContent = money(total);

  const marginPct = n(document.getElementById("marginPct")?.value);
  const finalPrice = Math.round(total * (1 + marginPct / 100));
  const finalCell = document.getElementById("finalPriceCell");
  if (finalCell) finalCell.textContent = moneyInt(finalPrice);
}

function renumberDOMIndices(){
  const trs = document.querySelectorAll("#tbody tr");
  trs.forEach((tr, newIdx) => {
    tr.dataset.row = String(newIdx);
    tr.querySelectorAll("[data-i]").forEach(el => el.dataset.i = String(newIdx));
    tr.querySelectorAll("[data-del]").forEach(el => el.dataset.del = String(newIdx));
  });
}

function renderTable(){
  const tbody = document.getElementById("tbody");
  if (!tbody) return;
  tbody.innerHTML = rowsState.map((r, i) => buildRowHTML(r, i)).join("");
  updateTotalAndPricing(rowsState);
}

function renderRecipeList(recipeNames){
  const list = document.getElementById("recipeList");
  if (!list) return;
  list.innerHTML = "";

  if (!recipeNames || !recipeNames.length){
    const empty = document.createElement("div");
    empty.className = "pill";
    empty.style.padding = "10px";
    empty.textContent = "No recipes saved yet. Create one above.";
    list.appendChild(empty);
    return;
  }

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

      // prevent pending debounced save from resurrecting recipes
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

      try{
        // remove full rows
        localStorage.removeItem(getRowsKey(name));
        // remove profile
        if (DB) await dbDeleteRecipe(DB, name);

        // if we deleted current, switch to another
        if (currentRecipe === name){
          const remaining = await listAllRecipeNames();
          if (remaining.length){
            await switchRecipe(remaining[0], true);
          }else{
            await switchRecipe("Default", true);
            saveRowsForRecipe("Default", rowsState);
          }
        }

        await refreshRecipesUI(); // reflect immediately (no need to close menu)
      }catch(err){
        console.error("Delete recipe failed:", err);
        alert("No se pudo eliminar la receta. Intenta nuevamente.");
      }
    });

    right.appendChild(delBtn);
    div.appendChild(left);
    div.appendChild(right);

    div.addEventListener("click", async () => {
      await switchRecipe(name, true);
      // opcional: si quieres cerrar al abrir, descomenta la siguiente línea
      // closeDrawer();
      await refreshRecipesUI();
    });

    list.appendChild(div);
  }
}

async function listAllRecipeNames(){
  // DB recipes
  const names = (DB) ? await dbListRecipes(DB) : [];
  // localStorage recipes
  const set = new Set(names);
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.startsWith(ROWS_KEY_PREFIX)){
      const rn = k.slice(ROWS_KEY_PREFIX.length);
      if (rn) set.add(rn);
    }
  }
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

async function refreshRecipesUI(){
  const merged = await listAllRecipeNames();
  renderRecipeList(merged);
}

async function ensureRowsForRecipe(recipeName){
  const fromLS = loadRowsForRecipe(recipeName);
  if (fromLS) return fromLS;

  // build from DB (Ingredient + RecipeAmmount) + ingredient cache for cost/amount
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

  return defaultRows();
}

async function switchRecipe(recipeName, persist){
  // prevent pending debounced save from writing into wrong recipe
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

  currentRecipe = recipeName;
  if (persist) setCurrentRecipe(recipeName);

  rowsState = await ensureRowsForRecipe(recipeName);
  saveRowsForRecipe(recipeName, rowsState);
  setRecipeTitle();
  renderTable();
}

// ---------------- Boot (DOM Ready) ----------------
document.addEventListener("DOMContentLoaded", async () => {
  // Drawer controls (safe if elements exist)
  document.getElementById("openDrawerBtn")?.addEventListener("click", openDrawer);
  document.getElementById("closeDrawerBtn")?.addEventListener("click", closeDrawer);
  document.getElementById("drawerOverlay")?.addEventListener("click", closeDrawer);

  // Margin init
  const marginEl = document.getElementById("marginPct");
  if (marginEl){
    marginEl.value = String(loadMarginPct());
    marginEl.addEventListener("input", (e) => {
      saveMarginPct(n(e.target.value));
      updateTotalAndPricing(rowsState);
    });
  }

  // Buttons
  document.getElementById("addRowBtn")?.addEventListener("click", () => {
    rowsState.push({ name:"", cost:0, amount:0, recipeAmount:0 });
    saveRowsForRecipe(currentRecipe, rowsState);

    const tbody = document.getElementById("tbody");
    const idx = rowsState.length - 1;
    tbody?.insertAdjacentHTML("beforeend", buildRowHTML(rowsState[idx], idx));
    updateTotalAndPricing(rowsState);

    tbody?.querySelector(`input[data-k="name"][data-i="${idx}"]`)?.focus();
    scheduleSave();
  });

  document.getElementById("resetBtn")?.addEventListener("click", () => {
    rowsState = defaultRows();
    saveRowsForRecipe(currentRecipe, rowsState);
    renderTable();
    scheduleSave();
    updateIngredientCacheFromRows(rowsState);
  });

  // Create recipe
  document.getElementById("createRecipeBtn")?.addEventListener("click", async () => {
    const input = document.getElementById("newRecipeName");
    const name = String(input?.value || "").trim();
    if (!name) return;

    await switchRecipe(name, true);
    saveRowsForRecipe(name, rowsState);
    if (input) input.value = "";
    await refreshRecipesUI();
  });

  // Save recipe profile to IndexedDB
  document.getElementById("saveRecipeBtn")?.addEventListener("click", async () => {
    if (!DB) return;
    try{
      updateIngredientCacheFromRows(rowsState);
      await dbPutItems(DB, currentRecipe, rowsState);
      await refreshRecipesUI();
    }catch(err){
      console.error("Save recipe failed:", err);
      alert("No se pudo guardar la receta. Intenta nuevamente.");
    }
  });

  // Table input delegation
  document.getElementById("tbody")?.addEventListener("input", (e) => {
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

    scheduleSave();
    updateIngredientCacheFromRows(rowsState);
  });

  document.getElementById("tbody")?.addEventListener("click", (e) => {
    const btn = e.target;
    if (!(btn instanceof HTMLElement)) return;

    const del = btn.getAttribute("data-del");
    if (del === null) return;

    const idx = Number(del);
    if (!Number.isFinite(idx)) return;

    rowsState.splice(idx, 1);

    const tr = document.querySelector(`#tbody tr[data-row="${idx}"]`);
    tr?.remove();

    if (!rowsState.length){
      rowsState = defaultRows();
      saveRowsForRecipe(currentRecipe, rowsState);
      renderTable();
      scheduleSave();
      updateIngredientCacheFromRows(rowsState);
      return;
    }

    renumberDOMIndices();
    saveRowsForRecipe(currentRecipe, rowsState);
    updateTotalAndPricing(rowsState);
    scheduleSave();
  });

  // Open DB
  try{
    DB = await openDB();
  }catch(err){
    console.warn("IndexedDB not available:", err);
    DB = null;
  }

  // Load current recipe
  currentRecipe = getCurrentRecipe();
  rowsState = await ensureRowsForRecipe(currentRecipe);
  saveRowsForRecipe(currentRecipe, rowsState);

  setRecipeTitle();
  renderTable();

  await refreshRecipesUI();
});
