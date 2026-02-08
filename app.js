const STORAGE_KEY = "dessert_cost_rows_v1";

function n(v){
  // parse number safely (accepts comma or dot)
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(",", ".");
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}

function money(v){
  // display as currency-like with no locale dependency
  const x = Math.round(v * 100) / 100;
  return "$" + x.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function defaultRows(){
  return [
    { name:"Flour", cost:1290, amount:1000, recipeAmount:300 },
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

function render(){
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";

  const rows = loadRows();
  let total = 0;

  rows.forEach((r, idx) => {
    const { unit, recipeCost } = computeRow(r);
    total += recipeCost;

    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td><input data-k="name" data-i="${idx}" value="${escapeHtml(r.name)}" placeholder="e.g., Flour"/></td>
      <td class="num"><input data-k="cost" data-i="${idx}" inputmode="decimal" value="${r.cost || ""}" placeholder="0"/></td>
      <td class="num"><input data-k="amount" data-i="${idx}" inputmode="decimal" value="${r.amount || ""}" placeholder="0"/></td>
      <td class="num readonly">${money(unit)}</td>
      <td class="num"><input data-k="recipeAmount" data-i="${idx}" inputmode="decimal" value="${r.recipeAmount || ""}" placeholder="0"/></td>
      <td class="num readonly">${money(recipeCost)}</td>
      <td class="num"><button class="btn btn-danger" data-del="${idx}">Delete</button></td>
    `;

    tbody.appendChild(tr);
  });

  document.getElementById("totalCell").textContent = money(total);

  // wire inputs
  tbody.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.i);
      const k = e.target.dataset.k;

      const rows2 = loadRows();
      if (!rows2[i]) return;

      if (k === "name") rows2[i].name = e.target.value;
      if (k === "cost") rows2[i].cost = n(e.target.value);
      if (k === "amount") rows2[i].amount = n(e.target.value);
      if (k === "recipeAmount") rows2[i].recipeAmount = n(e.target.value);

      saveRows(rows2);
      render(); // simple + reliable for small tables
    });
  });

  // wire delete
  tbody.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const i = Number(e.target.dataset.del);
      const rows2 = loadRows();
      rows2.splice(i, 1);
      saveRows(rows2.length ? rows2 : defaultRows());
      render();
    });
  });
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

document.getElementById("addRowBtn").addEventListener("click", () => {
  const rows = loadRows();
  rows.push({ name:"", cost:0, amount:0, recipeAmount:0 });
  saveRows(rows);
  render();
});

document.getElementById("resetBtn").addEventListener("click", () => {
  saveRows(defaultRows());
  render();
});

// initial
render();
