/**
 * Dessert Cost Calculator — multi-recipe + persistent profiles (IndexedDB)
 * + Favorites + Folders + Search + Safe migration (non-destructive)
 * + Backup Export/Import JSON (safe)
 */

const CURRENT_RECIPE_KEY = "dessert_current_recipe_v2";
const ROWS_KEY_PREFIX    = "dessert_rows__v2__";
const ING_CACHE_KEY      = "dessert_ingredient_cache_v2";
const MARGIN_KEY         = "dessert_margin_pct_v2";
const CLEAN_TEMPLATE_FLAG = "dessert_cleaned_legacy_template_v2";

// NEW (metadata) keys — safe additions
const META_KEY_V1        = "dessert_recipe_meta_v1";     // { [recipeName]: { favorite:boolean, folder:string } }
const FOLDERS_KEY_V1     = "dessert_folders_v1";         // [ "Tortas", "Chocolate", ... ]
const MIGRATION_FLAG_V1  = "dessert_migration_meta_v1_done";

// Backup helper key (only for re-download last)
const LAST_BACKUP_KEY_V1 = "dessert_last_backup_json_v1";

// IndexedDB
const DB_NAME = "dessert_profiles_db_v2";
const DB_VER  = 1;
const STORE_ITEMS = "recipe_items"; // key = `${recipeName}::${Ingredient}`

let DB = null;
let currentRecipe = getCurrentRecipe();
let rowsState = null;

// Drawer filter state (UI-only; not persisted)
let searchQuery = "";
let filterFolder = "";
let favOnly = false;

// debounce save
let saveTimer = null;

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
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function defaultRows(){
  return [{ name:"", cost:0, amount:0, recipeAmount:0 }];
}

function isLegacyTemplate(rows){
  if (!Array.isArray(rows) || rows.length !== 2) return false;
  const a = String(rows[0]?.name || "").trim().toLowerCase();
  const b = String(rows[1]?.name || "").trim().toLowerCase();
  return (a === "flour" && b === "sugar");
}

function maybeCleanLegacyTemplate(){
  try{
    if (localStorage.getItem(CLEAN_TEMPLATE_FLAG) === "1") return;
    const raw = localStorage.getItem(getRowsKey("Default"));
    if (!raw) { localStorage.setItem(CLEAN_TEMPLATE_FLAG, "1"); return; }
    const rows = JSON.parse(raw);
    if (isLegacyTemplate(rows)){
      localStorage.removeItem(getRowsKey("Default"));
    }
    localStorage.setItem(CLEAN_TEMPLATE_FLAG, "1");
  }catch{}
}

function getRowsKey(recipeName){ return ROWS_KEY_PREFIX + recipeName; }

function getCurrentRecipe(){
  const s = (localStorage.getItem(CURRENT_RECIPE_KEY) || "").trim();
  return s || "Default";
}
function setCurrentRecipe(name){ localStorage.setItem(CURRENT_RECIPE_KEY, name); }

function loadMarginPct(){
  const raw = localStorage.getItem(MARGIN_KEY);
  const val = (raw === null) ? 30 : n(raw);
  return Number.isFinite(val) ? val : 30;
}
function saveMarginPct(v){ localStorage.setItem(MARGIN_KEY, String(v)); }

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

/* =========================
   Meta + folders (safe)
   ========================= */
function loadFolders(){
  try{
    const raw = localStorage.getItem(FOLDERS_KEY_V1);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x.trim()).map(s => s.trim()) : [];
  }catch{
    return [];
  }
}
function saveFolders(folders){
  const clean = Array.from(new Set((folders || []).map(s => String(s || "").trim()).filter(Boolean)))
    .sort((a,b)=>a.localeCompare(b));
  localStorage.setItem(FOLDERS_KEY_V1, JSON.stringify(clean));
  return clean;
}

function loadMeta(){
  try{
    const raw = localStorage.getItem(META_KEY_V1);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  }catch{
    return {};
  }
}
function saveMeta(meta){
  localStorage.setItem(META_KEY_V1, JSON.stringify(meta || {}));
}

function ensureMetaForRecipe(meta, recipeName){
  if (!meta[recipeName] || typeof meta[recipeName] !== "object"){
    meta[recipeName] = { favorite: false, folder: "" };
  }else{
    if (typeof meta[recipeName].favorite !== "boolean") meta[recipeName].favorite = false;
    if (typeof meta[recipeName].folder !== "string") meta[recipeName].folder = "";
  }
  return meta;
}

function runSafeMigration(){
  try{
    if (localStorage.getItem(MIGRATION_FLAG_V1) === "1") return;

    const existingMeta = localStorage.getItem(META_KEY_V1);
    const existingFolders = localStorage.getItem(FOLDERS_KEY_V1);
    if (existingMeta || existingFolders){
      localStorage.setItem(MIGRATION_FLAG_V1, "1");
      return;
    }

    // Initialize empty, non-destructive
    saveFolders([]);
    saveMeta({});
    localStorage.setItem(MIGRATION_FLAG_V1, "1");
  }catch{}
}

/* =========================
   Rows load/save
   ========================= */
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
  for (let i=0;i<rows.length;i++){
    total += computeRow(rows[i]).recipeCost;
  }
  return total;
}

// Drawer open/close
function openDrawer(){ document.body.classList.add("drawer-open"); }
function closeDrawer(){ document.body.classList.remove("drawer-open"); }

// IndexedDB
function openDB(){
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB not available"));
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
  for (let i=0;i<all.length;i++){
    const it = all[i];
    if (it && typeof it.recipeName === "string" && it.recipeName.trim()){
      set.add(it.recipeName);
    }
  }
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

async function dbPutItems(db, recipeName, rows){
  const existing = await dbGetItems(db, recipeName);

  const tx = db.transaction(STORE_ITEMS, "readwrite");
  const store = tx.objectStore(STORE_ITEMS);

  for (let i=0;i<existing.length;i++){
    store.delete(existing[i].key);
  }

  for (let i=0;i<rows.length;i++){
    const r = rows[i];
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
  const existing = await dbGetItems(db, recipeName);

  const tx = db.transaction(STORE_ITEMS, "readwrite");
  const store = tx.objectStore(STORE_ITEMS);

  for (let i=0;i<existing.length;i++){
    store.delete(existing[i].key);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// UI helpers
function setRecipeTitle(){
  const el = document.getElementById("recipeTitle");
  if (el) el.textContent = currentRecipe;
}

function updateIngredientCacheFromRows(rows){
  const cache = loadIngredientCache();
  for (let i=0;i<rows.length;i++){
    const r = rows[i];
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

  const marginEl = document.getElementById("marginPct");
  const marginPct = marginEl ? n(marginEl.value) : 0;

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

async function listAllRecipeNames(){
  const names = DB ? await dbListRecipes(DB) : [];
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

function matchesFilters(recipeName, meta){
  const q = String(searchQuery || "").trim().toLowerCase();
  if (q && !recipeName.toLowerCase().includes(q)) return false;

  if (favOnly){
    const m = meta[recipeName];
    if (!m || !m.favorite) return false;
  }

  if (filterFolder){
    const m = meta[recipeName];
    const fd = (m && typeof m.folder === "string") ? m.folder : "";
    if (fd !== filterFolder) return false;
  }
  return true;
}

function renderRecipeList(recipeNames){
  const list = document.getElementById("recipeList");
  if (!list) return;
  list.innerHTML = "";

  const meta = loadMeta();
  for (const rn of recipeNames) ensureMetaForRecipe(meta, rn);
  saveMeta(meta);

  const filtered = (recipeNames || []).filter(rn => matchesFilters(rn, meta));

  if (!filtered.length){
    const empty = document.createElement("div");
    empty.className = "pill";
    empty.style.padding = "10px";
    empty.textContent = "No hay recetas con esos filtros.";
    list.appendChild(empty);
    return;
  }

  for (const name of filtered){
    const m = meta[name] || { favorite:false, folder:"" };

    const div = document.createElement("div");
    div.className = "recipeItem" + (name === currentRecipe ? " active" : "");
    div.setAttribute("role", "listitem");

    const left = document.createElement("div");
    left.className = "recipeLeft";
    left.style.minWidth = "0";

    const star = m.favorite ? "★" : "☆";
    const folderBadge = m.folder ? `<span class="badge">${escapeHtml(m.folder)}</span>` : `<span class="badge">(Sin carpeta)</span>`;

    left.innerHTML =
      `<div class="recipeName"><span>${escapeHtml(name)}</span> <span class="pill">${star}</span></div>` +
      `<div>${folderBadge}</div>`;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    right.style.alignItems = "center";

    const favBtn = document.createElement("button");
    favBtn.className = "iconBtn" + (m.favorite ? " favOn" : "");
    favBtn.type = "button";
    favBtn.textContent = m.favorite ? "★" : "☆";
    favBtn.title = "Favorita";
    favBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const meta2 = loadMeta();
      ensureMetaForRecipe(meta2, name);
      meta2[name].favorite = !meta2[name].favorite;
      saveMeta(meta2);
      syncCurrentRecipeMetaUI();
      refreshRecipesUI();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "iconBtn danger";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

      try{
        localStorage.removeItem(getRowsKey(name));
        if (DB) await dbDeleteRecipe(DB, name);

        try{
          const meta3 = loadMeta();
          if (meta3 && meta3[name]) { delete meta3[name]; saveMeta(meta3); }
        }catch{}

        if (currentRecipe === name){
          const remaining = await listAllRecipeNames();
          if (remaining.length) await switchRecipe(remaining[0], true);
          else{
            await switchRecipe("Default", true);
            saveRowsForRecipe("Default", rowsState);
          }
        }

        closeDrawer();
        await refreshRecipesUI();
        await refreshFoldersUI();
        syncCurrentRecipeMetaUI();
      }catch(err){
        console.error("Delete recipe failed:", err);
        alert("No se pudo eliminar la receta. Intenta nuevamente.");
      }
    });

    right.appendChild(favBtn);
    right.appendChild(delBtn);

    div.appendChild(left);
    div.appendChild(right);

    div.addEventListener("click", async () => {
      await switchRecipe(name, true);
      closeDrawer();
      await refreshRecipesUI();
      syncCurrentRecipeMetaUI();
    });

    list.appendChild(div);
  }
}

async function refreshRecipesUI(){
  const merged = await listAllRecipeNames();
  renderRecipeList(merged);
  refreshFolderFilterOptions();
}

async function ensureRowsForRecipe(recipeName){
  const fromLS = loadRowsForRecipe(recipeName);
  if (fromLS) return fromLS;

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
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

  currentRecipe = recipeName;
  if (persist) setCurrentRecipe(recipeName);

  rowsState = await ensureRowsForRecipe(recipeName);
  saveRowsForRecipe(recipeName, rowsState);

  try{
    const meta = loadMeta();
    ensureMetaForRecipe(meta, currentRecipe);
    saveMeta(meta);
  }catch{}

  setRecipeTitle();
  renderTable();
}

function scheduleSave(){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try{ saveRowsForRecipe(currentRecipe, rowsState); }catch(e){}
  }, 250);
}

async function createRecipeClean(name){
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

  try{ localStorage.removeItem(getRowsKey(name)); }catch{}
  if (DB){
    try{ await dbDeleteRecipe(DB, name); }catch{}
  }

  try{
    const meta = loadMeta();
    ensureMetaForRecipe(meta, name);
    if (filterFolder) meta[name].folder = filterFolder;
    saveMeta(meta);
  }catch{}

  currentRecipe = name;
  setCurrentRecipe(name);

  rowsState = defaultRows();
  saveRowsForRecipe(name, rowsState);

  setRecipeTitle();
  renderTable();

  await refreshRecipesUI();
  await refreshFoldersUI();
  syncCurrentRecipeMetaUI();
  closeDrawer();
}

/* =========================
   Folders UI
   ========================= */
function refreshFolderSelectOptions(){
  const folders = loadFolders();
  const currentSel = document.getElementById("currentFolderSelect");
  if (currentSel){
    const prev = currentSel.value || "";
    currentSel.innerHTML = `<option value="">(Sin carpeta)</option>` + folders.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
    currentSel.value = folders.includes(prev) ? prev : "";
  }
}

function refreshFolderFilterOptions(){
  const folders = loadFolders();
  const filterSel = document.getElementById("folderFilter");
  if (!filterSel) return;
  const prev = filterSel.value || "";
  filterSel.innerHTML = `<option value="">Todas</option>` + folders.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
  filterSel.value = folders.includes(prev) ? prev : (prev === "" ? "" : "");
}

function renderFoldersList(){
  const wrap = document.getElementById("foldersList");
  if (!wrap) return;

  const folders = loadFolders();
  wrap.innerHTML = "";

  if (!folders.length){
    const empty = document.createElement("div");
    empty.className = "pill";
    empty.style.padding = "10px";
    empty.textContent = "Aún no tienes carpetas. Crea una arriba.";
    wrap.appendChild(empty);
    return;
  }

  for (const f of folders){
    const row = document.createElement("div");
    row.className = "folderItem";

    const left = document.createElement("div");
    left.className = "folderName";
    left.textContent = f;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    right.style.alignItems = "center";

    const applyBtn = document.createElement("button");
    applyBtn.className = "iconBtn";
    applyBtn.type = "button";
    applyBtn.textContent = "Filtrar";
    applyBtn.addEventListener("click", async () => {
      filterFolder = f;
      const sel = document.getElementById("folderFilter");
      if (sel) sel.value = f;
      await refreshRecipesUI();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "iconBtn danger";
    delBtn.type = "button";
    delBtn.textContent = "Eliminar";
    delBtn.addEventListener("click", async () => {
      const ok = confirm(`¿Eliminar la carpeta "${f}"?\n\nEsto NO elimina recetas, solo las deja sin carpeta.`);
      if (!ok) return;

      let folders2 = loadFolders().filter(x => x !== f);
      folders2 = saveFolders(folders2);

      const meta = loadMeta();
      for (const rn of Object.keys(meta)){
        if (meta[rn] && meta[rn].folder === f){
          meta[rn].folder = "";
        }
      }
      saveMeta(meta);

      if (filterFolder === f) filterFolder = "";
      const filterSel = document.getElementById("folderFilter");
      if (filterSel) filterSel.value = filterFolder;

      refreshFolderSelectOptions();
      refreshFolderFilterOptions();
      renderFoldersList();
      syncCurrentRecipeMetaUI();
      await refreshRecipesUI();
    });

    right.appendChild(applyBtn);
    right.appendChild(delBtn);

    row.appendChild(left);
    row.appendChild(right);

    wrap.appendChild(row);
  }
}

async function refreshFoldersUI(){
  refreshFolderSelectOptions();
  refreshFolderFilterOptions();
  renderFoldersList();
}

function syncCurrentRecipeMetaUI(){
  const meta = loadMeta();
  ensureMetaForRecipe(meta, currentRecipe);
  saveMeta(meta);

  const m = meta[currentRecipe];

  const favBtn = document.getElementById("toggleFavoriteBtn");
  if (favBtn){
    favBtn.textContent = m.favorite ? "★" : "☆";
    favBtn.classList.toggle("favOn", !!m.favorite);
    favBtn.title = m.favorite ? "Quitar de favoritas" : "Marcar como favorita";
  }

  const currentSel = document.getElementById("currentFolderSelect");
  if (currentSel){
    currentSel.value = (typeof m.folder === "string" ? m.folder : "") || "";
  }
}

/* =========================
   Backup Export/Import
   ========================= */
function setBackupStatus(msg){
  const el = document.getElementById("backupStatus");
  if (el) el.textContent = msg;
}

function downloadTextFile(filename, text){
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function buildBackupObject(){
  const names = await listAllRecipeNames();
  const meta = loadMeta();
  const folders = loadFolders();

  // Ensure meta exists for listed recipes
  for (const rn of names) ensureMetaForRecipe(meta, rn);

  const marginPct = loadMarginPct();
  const ingredientCache = loadIngredientCache();

  // rows: prefer localStorage; fallback to DB reconstruct if needed
  const recipes = {};

  for (const rn of names){
    let rows = loadRowsForRecipe(rn);

    // If not in localStorage, reconstruct from DB (if possible)
    if (!rows && DB){
      try{
        const items = await dbGetItems(DB, rn);
        if (items && items.length){
          rows = items.map(it => {
            const c = ingredientCache[it.Ingredient] || { cost: 0, amount: 0 };
            return {
              name: String(it.Ingredient || ""),
              cost: n(c.cost),
              amount: n(c.amount),
              recipeAmount: n(it.RecipeAmmount),
            };
          });
        }
      }catch{}
    }

    if (!rows) rows = defaultRows();

    recipes[rn] = {
      rows,
      meta: meta[rn] || { favorite:false, folder:"" },
    };
  }

  return {
    app: "DessertCostCalculator",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    currentRecipe: getCurrentRecipe(),
    settings: {
      marginPct,
      ingredientCache,
    },
    folders,
    recipes
  };
}

async function exportBackup(){
  try{
    setBackupStatus("Generando respaldo…");
    const obj = await buildBackupObject();
    const json = JSON.stringify(obj, null, 2);

    // store last backup for re-download
    try{ localStorage.setItem(LAST_BACKUP_KEY_V1, json); }catch{}

    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
    downloadTextFile(`dessert-backup-${stamp}.json`, json);

    setBackupStatus(`Respaldo exportado (${Object.keys(obj.recipes || {}).length} recetas).`);
  }catch(err){
    console.error(err);
    setBackupStatus("Error exportando respaldo.");
    alert("No se pudo exportar el respaldo. Revisa la consola.");
  }
}

function readFileAsText(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error || new Error("File read error"));
    fr.readAsText(file);
  });
}

function isValidBackupObject(obj){
  if (!obj || typeof obj !== "object") return false;
  if (obj.app !== "DessertCostCalculator") return false;
  if (!Number.isFinite(obj.schemaVersion)) return false;
  if (!obj.recipes || typeof obj.recipes !== "object") return false;
  return true;
}

async function importBackupFromJsonText(jsonText, overwrite){
  let obj;
  try{
    obj = JSON.parse(jsonText);
  }catch{
    alert("El archivo no es un JSON válido.");
    return;
  }

  if (!isValidBackupObject(obj)){
    alert("Este respaldo no corresponde a esta app o está incompleto.");
    return;
  }

  const incomingFolders = Array.isArray(obj.folders) ? obj.folders : [];
  const incomingRecipes = obj.recipes || {};

  // Merge folders
  const foldersMerged = saveFolders([...loadFolders(), ...incomingFolders]);

  // Merge meta
  const meta = loadMeta();

  const incomingNames = Object.keys(incomingRecipes);
  for (const rn of incomingNames){
    const rec = incomingRecipes[rn];
    if (!rec || typeof rec !== "object") continue;

    ensureMetaForRecipe(meta, rn);

    // If overwrite: meta replaced; else: merge (incoming wins if present)
    const incMeta = rec.meta && typeof rec.meta === "object" ? rec.meta : null;
    if (incMeta){
      meta[rn].favorite = (typeof incMeta.favorite === "boolean") ? incMeta.favorite : meta[rn].favorite;
      meta[rn].folder   = (typeof incMeta.folder === "string") ? incMeta.folder : meta[rn].folder;
    }
  }
  saveMeta(meta);

  // Import settings (merge)
  try{
    if (obj.settings && typeof obj.settings === "object"){
      if (typeof obj.settings.marginPct === "number"){
        saveMarginPct(obj.settings.marginPct);
        const marginEl = document.getElementById("marginPct");
        if (marginEl) marginEl.value = String(obj.settings.marginPct);
      }
      if (obj.settings.ingredientCache && typeof obj.settings.ingredientCache === "object"){
        // merge cache
        const cur = loadIngredientCache();
        const merged = { ...cur, ...obj.settings.ingredientCache };
        saveIngredientCache(merged);
      }
    }
  }catch{}

  // Import recipes rows
  for (const rn of incomingNames){
    const rec = incomingRecipes[rn];
    if (!rec || typeof rec !== "object") continue;

    const rows = Array.isArray(rec.rows) ? rec.rows : null;
    if (!rows) continue;

    const sanitized = rows.map(r => ({
      name: String(r?.name ?? ""),
      cost: n(r?.cost),
      amount: n(r?.amount),
      recipeAmount: n(r?.recipeAmount),
    }));

    // Merge vs overwrite at recipe level:
    // - overwrite: replace localStorage rows & DB for that recipe
    // - merge: if recipe exists, we still replace its rows because “merge rows” is ambiguous
    //          (this is the safest: the backup is the source of truth for that recipe)
    // If you want true merge rows, lo hacemos después.
    saveRowsForRecipe(rn, sanitized);

    if (DB){
      try{ await dbPutItems(DB, rn, sanitized); }catch{}
    }
  }

  // Set current recipe if exists
  const desiredCurrent = String(obj.currentRecipe || "").trim();
  if (desiredCurrent && incomingRecipes[desiredCurrent]){
    await switchRecipe(desiredCurrent, true);
  }else{
    // keep current
    await switchRecipe(getCurrentRecipe(), true);
  }

  // Refresh UI
  await refreshFoldersUI();
  await refreshRecipesUI();
  syncCurrentRecipeMetaUI();

  setBackupStatus(`Importado: ${incomingNames.length} recetas. Carpetas: ${foldersMerged.length}.`);
}

async function importBackup(){
  const fileInput = document.getElementById("importFile");
  const overwriteToggle = document.getElementById("importOverwriteToggle");
  const overwrite = !!(overwriteToggle && overwriteToggle.checked);

  if (!fileInput || !fileInput.files || !fileInput.files.length){
    alert("Selecciona un archivo .json primero.");
    return;
  }

  const file = fileInput.files[0];

  const ok = confirm(
    overwrite
      ? "Vas a IMPORTAR con SOBRESCRITURA.\n\nLas recetas del respaldo reemplazarán recetas con el mismo nombre.\n\n¿Continuar?"
      : "Vas a IMPORTAR en modo FUSIÓN.\n\nNo se borra nada; se agregan/actualizan recetas del respaldo.\n\n¿Continuar?"
  );
  if (!ok) return;

  try{
    setBackupStatus("Leyendo respaldo…");
    const txt = await readFileAsText(file);
    await importBackupFromJsonText(txt, overwrite);
  }catch(err){
    console.error(err);
    setBackupStatus("Error importando respaldo.");
    alert("No se pudo importar. Revisa la consola.");
  }finally{
    try{ fileInput.value = ""; }catch{}
  }
}

function downloadLastBackup(){
  const raw = localStorage.getItem(LAST_BACKUP_KEY_V1);
  if (!raw){
    alert("Aún no has exportado un respaldo en este navegador.");
    return;
  }
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
  downloadTextFile(`dessert-backup-LAST-${stamp}.json`, raw);
}

/* =========================
   Boot
   ========================= */
document.addEventListener("DOMContentLoaded", async () => {
  runSafeMigration();

  // Drawer listeners FIRST
  const openBtn = document.getElementById("openDrawerBtn");
  const closeBtn = document.getElementById("closeDrawerBtn");
  const overlay = document.getElementById("drawerOverlay");

  if (openBtn) openBtn.addEventListener("click", openDrawer);
  if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
  if (overlay) overlay.addEventListener("click", closeDrawer);

  maybeCleanLegacyTemplate();

  // Margin init
  const marginEl = document.getElementById("marginPct");
  if (marginEl){
    marginEl.value = String(loadMarginPct());
    marginEl.addEventListener("input", (e) => {
      saveMarginPct(n(e.target.value));
      if (rowsState) updateTotalAndPricing(rowsState);
    });
  }

  // Search + filters
  const searchEl = document.getElementById("recipeSearch");
  if (searchEl){
    searchEl.addEventListener("input", async (e) => {
      searchQuery = String(e.target.value || "");
      await refreshRecipesUI();
    });
  }

  const folderFilterEl = document.getElementById("folderFilter");
  if (folderFilterEl){
    folderFilterEl.addEventListener("change", async (e) => {
      filterFolder = String(e.target.value || "");
      await refreshRecipesUI();
    });
  }

  const favOnlyEl = document.getElementById("favOnlyToggle");
  if (favOnlyEl){
    favOnlyEl.addEventListener("change", async (e) => {
      favOnly = !!e.target.checked;
      await refreshRecipesUI();
    });
  }

  const resetFiltersBtn = document.getElementById("resetFiltersBtn");
  if (resetFiltersBtn){
    resetFiltersBtn.addEventListener("click", async () => {
      searchQuery = "";
      filterFolder = "";
      favOnly = false;

      const s = document.getElementById("recipeSearch");
      const f = document.getElementById("folderFilter");
      const c = document.getElementById("favOnlyToggle");
      if (s) s.value = "";
      if (f) f.value = "";
      if (c) c.checked = false;

      await refreshRecipesUI();
    });
  }

  // Buttons
  const addRowBtn = document.getElementById("addRowBtn");
  if (addRowBtn) addRowBtn.addEventListener("click", () => {
    rowsState.push({ name:"", cost:0, amount:0, recipeAmount:0 });
    saveRowsForRecipe(currentRecipe, rowsState);

    const tbody = document.getElementById("tbody");
    const idx = rowsState.length - 1;
    if (tbody) tbody.insertAdjacentHTML("beforeend", buildRowHTML(rowsState[idx], idx));

    updateTotalAndPricing(rowsState);
    scheduleSave();
  });

  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    rowsState = defaultRows();
    saveRowsForRecipe(currentRecipe, rowsState);
    renderTable();
    scheduleSave();
    updateIngredientCacheFromRows(rowsState);
  });

  const createBtn = document.getElementById("createRecipeBtn");
  if (createBtn) createBtn.addEventListener("click", async () => {
    const input = document.getElementById("newRecipeName");
    const name = String(input ? input.value : "").trim();
    if (!name) return;
    await createRecipeClean(name);
    if (input) input.value = "";
  });

  const saveBtn = document.getElementById("saveRecipeBtn");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    if (!DB) {
      alert("IndexedDB no disponible en este navegador.");
      return;
    }
    try{
      updateIngredientCacheFromRows(rowsState);
      await dbPutItems(DB, currentRecipe, rowsState);
      await refreshRecipesUI();
    }catch(err){
      console.error("Save recipe failed:", err);
      alert("No se pudo guardar la receta. Intenta nuevamente.");
    }
  });

  // Favorite toggle (current recipe)
  const toggleFavBtn = document.getElementById("toggleFavoriteBtn");
  if (toggleFavBtn){
    toggleFavBtn.addEventListener("click", async () => {
      const meta = loadMeta();
      ensureMetaForRecipe(meta, currentRecipe);
      meta[currentRecipe].favorite = !meta[currentRecipe].favorite;
      saveMeta(meta);
      syncCurrentRecipeMetaUI();
      await refreshRecipesUI();
    });
  }

  // Folder assign (current recipe)
  const currentFolderSelect = document.getElementById("currentFolderSelect");
  if (currentFolderSelect){
    currentFolderSelect.addEventListener("change", async (e) => {
      const folder = String(e.target.value || "");
      const meta = loadMeta();
      ensureMetaForRecipe(meta, currentRecipe);
      meta[currentRecipe].folder = folder;
      saveMeta(meta);
      syncCurrentRecipeMetaUI();
      await refreshRecipesUI();
    });
  }

  const clearFolderBtn = document.getElementById("clearFolderBtn");
  if (clearFolderBtn){
    clearFolderBtn.addEventListener("click", async () => {
      const meta = loadMeta();
      ensureMetaForRecipe(meta, currentRecipe);
      meta[currentRecipe].folder = "";
      saveMeta(meta);
      syncCurrentRecipeMetaUI();
      await refreshRecipesUI();
    });
  }

  // Create folder
  const createFolderBtn = document.getElementById("createFolderBtn");
  if (createFolderBtn){
    createFolderBtn.addEventListener("click", async () => {
      const input = document.getElementById("newFolderName");
      const name = String(input ? input.value : "").trim();
      if (!name) return;

      saveFolders([...loadFolders(), name]);
      if (input) input.value = "";

      await refreshFoldersUI();
      await refreshRecipesUI();
    });
  }

  // Backup buttons
  const exportBtn = document.getElementById("exportBackupBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportBackup);

  const importBtn = document.getElementById("importBackupBtn");
  if (importBtn) importBtn.addEventListener("click", importBackup);

  const downloadLastBtn = document.getElementById("downloadLastBackupBtn");
  if (downloadLastBtn) downloadLastBtn.addEventListener("click", downloadLastBackup);

  // Table events
  const tbody = document.getElementById("tbody");
  if (tbody){
    tbody.addEventListener("input", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;

      const k = t.dataset.k;
      const i = Number(t.dataset.i);
      if (!k || !Number.isFinite(i) || !rowsState[i]) return;

      if (k === "name") rowsState[i].name = t.value;
      if (k === "cost") rowsState[i].cost = n(t.value);
      if (k === "amount") rowsState[i].amount = n(t.value);
      if (k === "recipeAmount") rowsState[i].recipeAmount = n(t.value);

      updateComputedForIndex(rowsState, i);
      updateTotalAndPricing(rowsState);

      scheduleSave();
      updateIngredientCacheFromRows(rowsState);
    });

    tbody.addEventListener("click", (e) => {
      const btn = e.target;
      if (!(btn instanceof HTMLElement)) return;
      const del = btn.getAttribute("data-del");
      if (del === null) return;

      const idx = Number(del);
      if (!Number.isFinite(idx)) return;

      rowsState.splice(idx, 1);

      const tr = document.querySelector(`#tbody tr[data-row="${idx}"]`);
      if (tr) tr.remove();

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
  }

  // Open DB (non-blocking)
  try{
    DB = await openDB();
  }catch(err){
    console.warn("IndexedDB not available:", err);
    DB = null;
  }

  // Load initial recipe
  currentRecipe = getCurrentRecipe();
  rowsState = await ensureRowsForRecipe(currentRecipe);
  saveRowsForRecipe(currentRecipe, rowsState);

  try{
    const meta = loadMeta();
    ensureMetaForRecipe(meta, currentRecipe);
    saveMeta(meta);
  }catch{}

  setRecipeTitle();
  renderTable();

  await refreshFoldersUI();
  await refreshRecipesUI();
  syncCurrentRecipeMetaUI();

  setBackupStatus("Listo. Exporta un JSON cuando quieras.");
});
