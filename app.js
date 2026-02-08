const STORAGE_KEY = "dessert_cost_rows_v1";

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

function defaultRows(){
  return [
    { name:"Flour", costo:1290, amount:1000, recipeAmount:300 },
    { name:"Sugar", cost:0, amount:0, recipeAmount:0 },
  ];
}

function loadRows(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultRows();
    const rows = JSON.parse(raw);
    if(!Array.isArray(rows)) return defaultRows();
    return rows.map(r => ({
      name: r.name ?? "",
      cost: n(r.cost),
      amount: n(r.amount),
      recipeAmount: n(r.recipeAmount),
    }));
  }catch{
    return defaultRows();
  }
}

function saveRows(rows){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

function computeRow(r){
  const unit = (r.amount > 0) ? (r.cost / r.amount) : 0;
  const recipeCost = unit * r.recipeAmount;
  return { unit, recipeCost };
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---- Debounce para no escribir localStorage a cada tecla
let saveTimer = null;
function scheduleSave(rows){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveRows(rows), 250);
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

function updateTotal(rows){
  let total = 0;
  for (const r of rows){
    total += computeRow(r).recipeCost;
  }
  document.getElementById("totalCell").textContent = money(total);
}

function renumberDOMIndices(){
  // Reindexa data-i y data-del luego de borrar filas (sin re-render completo)
  const trs = document.querySelectorAll("#tbody tr");
  trs.forEach((tr, newIdx) => {
    tr.dataset.row = String(newIdx);

    tr.querySelectorAll("[data-i]").forEach(el => el.dataset.i = String(newIdx));
    tr.querySelectorAll("[data-del]").forEach(el => el.dataset.del = String(newIdx));
  });
}

function initialRender(){
  const rows = loadRows();
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = rows.map((r, i) => buildRowHTML(r, i)).join("");
  updateTotal(rows);
}

// ---- Event delegation: NO re-render al escribir (evita que iOS cierre teclado)
document.getElementById("tbody").addEventListener("input", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;

  const k = t.dataset.k;
  const i = Number(t.dataset.i);
  if (!k || !Number.isFinite(i)) return;

  const rows = loadRows();
  if (!rows[i]) return;

  if (k === "name") rows[i].name = t.value;
  if (k === "cost") rows[i].cost = n(t.value);
  if (k === "amount") rows[i].amount = n(t.value);
  if (k === "recipeAmount") rows[i].recipeAmount = n(t.value);

  // actualiza SOLO celdas calculadas + total
  updateComputedForIndex(rows, i);
  updateTotal(rows);

  // guarda con debounce
  scheduleSave(rows);
});

document.getElementById("tbody").addEventListener("click", (e) => {
  const btn = e.target;
  if (!(btn instanceof HTMLElement)) return;

  const del = btn.getAttribute("data-del");
  if (del === null) return;

  const idx = Number(del);
  if (!Number.isFinite(idx)) return;

  const rows = loadRows();
  rows.splice(idx, 1);
  const newRows = rows.length ? rows : defaultRows();

  // Remueve la fila del DOM sin re-render total
  const tr = document.querySelector(`#tbody tr[data-row="${idx}"]`);
  if (tr) tr.remove();

  // Si quedó vacío, re-render inicial para volver a default
  if (!rows.length){
    saveRows(newRows);
    initialRender();
    return;
  }

  // Reindexa DOM y guarda
  renumberDOMIndices();
  saveRows(newRows);

  // Recalcula totales y computed (por seguridad)
  // (las filas restantes mantienen sus computed, pero el total sí cambia)
  updateTotal(newRows);
});

document.getElementById("addRowBtn").addEventListener("click", () => {
  const rows = loadRows();
  rows.push({ name:"", cost:0, amount:0, recipeAmount:0 });
  saveRows(rows);

  const tbody = document.getElementById("tbody");
  const idx = rows.length - 1;

  // agrega solo una fila
  tbody.insertAdjacentHTML("beforeend", buildRowHTML(rows[idx], idx));
  updateTotal(rows);

  // foco en el nombre para empezar a escribir sin taps extra
  const nameInput = tbody.querySelector(`input[data-k="name"][data-i="${idx}"]`);
  if (nameInput) nameInput.focus();
});

document.getElementById("resetBtn").addEventListener("click", () => {
  const rows = defaultRows();
  saveRows(rows);
  initialRender();
});

// initial
initialRender();

