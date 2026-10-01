(() => {
"use strict";

const DB_NAME = "shailu_bhai_collection_v1";
const DB_VERSION = 1;
const STORES = ["customers","loans","payments","expenses","settings"];
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const money = n => "₹" + Number(n || 0).toLocaleString("en-IN",{maximumFractionDigits:2});
const uid = prefix => prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2,7).toUpperCase();
const isoToday = () => new Date().toISOString().slice(0,10);
const fmtDate = d => d ? new Date(d+"T00:00:00").toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "-";
const esc = s => String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const num = v => Math.max(0, Number(v) || 0);
const cloneData = v => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

let db;
let state = {customers:[],loans:[],payments:[],expenses:[],settings:null};
let loanFilter = "active";

const DEFAULT_SETTINGS = {
  plans: [
    {key:"5000",name:"₹5,000",amount:5000,cut:20,days:30},
    {key:"10000",name:"₹10,000",amount:10000,cut:20,days:30},
    {key:"15000",name:"₹15,000",amount:15000,cut:20,days:30},
    {key:"50000",name:"₹50,000",amount:50000,cut:20,days:50}
  ]
};

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains("customers")) d.createObjectStore("customers",{keyPath:"id"});
      if(!d.objectStoreNames.contains("loans")) d.createObjectStore("loans",{keyPath:"id"});
      if(!d.objectStoreNames.contains("payments")) d.createObjectStore("payments",{keyPath:"id"});
      if(!d.objectStoreNames.contains("expenses")) d.createObjectStore("expenses",{keyPath:"id"});
      if(!d.objectStoreNames.contains("settings")) d.createObjectStore("settings",{keyPath:"id"});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function tx(store,mode="readonly"){return db.transaction(store,mode).objectStore(store)}
function getAll(store){return new Promise((resolve,reject)=>{const r=tx(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
function put(store,obj){return new Promise((resolve,reject)=>{const r=tx(store,"readwrite").put(obj);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function del(store,id){return new Promise((resolve,reject)=>{const r=tx(store,"readwrite").delete(id);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})}
async function clearStore(store){return new Promise((resolve,reject)=>{const r=tx(store,"readwrite").clear();r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})}

async function load(){
  db=await openDB();
  for(const s of STORES) state[s]=await getAll(s);
  let settings=state.settings.find(x=>x.id==="app");
  if(!settings){settings={id:"app",plans:cloneData(DEFAULT_SETTINGS.plans),createdAt:Date.now()};await put("settings",settings);state.settings=[settings]}
  state.settings=state.settings.length?state.settings:[settings];
  renderAll();
}

function getSettings(){return state.settings.find(x=>x.id==="app")||DEFAULT_SETTINGS}
function customerById(id){return state.customers.find(c=>c.id===id)}
function loanById(id){return state.loans.find(l=>l.id===id)}
function customerName(id){return customerById(id)?.name||"Unknown customer"}

function planForAmount(amount){
  const plans=getSettings().plans||DEFAULT_SETTINGS.plans;
  return plans.find(p=>Number(p.amount)===Number(amount)) || {name:"Custom",amount:Number(amount),cut:20,days:30,key:"custom"};
}

function loanTotals(loan, upto=isoToday()){
  const payments=state.payments.filter(p=>p.loanId===loan.id && p.date<=upto).sort((a,b)=>a.date.localeCompare(b.date));
  const start=new Date(loan.startDate+"T00:00:00");
  const end=new Date(loan.startDate+"T00:00:00"); end.setDate(end.getDate()+Number(loan.days||30)-1);
  const limit= new Date(Math.min(new Date(upto+"T00:00:00").getTime(),end.getTime()));
  let days=0;
  if(limit>=start) days=Math.floor((limit-start)/86400000)+1;
  days=Math.min(days,Number(loan.days||30));
  const expected=Math.max(0,days*Number(loan.dailyDue||0));
  const collected=payments.reduce((s,p)=>s+num(p.actual),0);
  const adjustments=payments.reduce((s,p)=>s+Number(p.adjustment||0),0);
  const penalties=payments.reduce((s,p)=>s+num(p.penalty),0);
  const paidCredit=collected+adjustments;
  const outstanding=Math.max(0,expected+penalties-paidCredit);
  const extra=Math.max(0,paidCredit-(expected+penalties));
  const completedDays=Math.min(Number(loan.days||30),Math.floor(collected/Math.max(Number(loan.dailyDue||1),0.000001)));
  const scheduleComplete=days>=Number(loan.days||30);
  const complete=scheduleComplete && outstanding<=0.000001;
  return {payments,days,expected,collected,adjustments,penalties,outstanding,extra,completedDays,scheduleComplete,complete};
}

function loanDailyDue(loan){return Number(loan.dailyDue||0)}
function loanStatus(loan){
  if(loan.status==="archived") return "archived";
  const t=loanTotals(loan);
  if(t.complete) return "completed";
  const today=isoToday();
  const start=loan.startDate;
  const end=new Date(start+"T00:00:00");end.setDate(end.getDate()+Number(loan.days||30)-1);
  const activeWindow=today>=start && today<=end.toISOString().slice(0,10);
  return activeWindow || t.outstanding>0 ? "active" : "pending";
}
function statusPill(status){
  const map={active:["Active","blue"],completed:["Completed","green"],archived:["Archive","green"],pending:["Pending","yellow"]};
  const x=map[status]||[status,""];
  return `<span class="pill ${x[1]}">${x[0]}</span>`;
}

function showToast(msg){
  const t=$("#toast");t.textContent=msg;t.classList.add("show");
  clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>t.classList.remove("show"),2200);
}
function confirmAction(msg){return window.confirm(msg)}
function showModal(title,body){
  const root=$("#modalRoot");
  root.innerHTML=`<div class="modal"><div class="modal-head"><h2>${title}</h2><button class="close-btn" data-close>×</button></div>${body}</div>`;
  root.classList.remove("hidden");
  root.onclick=e=>{if(e.target===root || e.target.closest("[data-close]")) closeModal()};
}
function closeModal(){$("#modalRoot").classList.add("hidden");$("#modalRoot").innerHTML=""}

function navigate(screen){
  $$(".screen").forEach(x=>x.classList.toggle("active",x.id===screen));
  $$(".nav-item").forEach(x=>x.classList.toggle("active",x.dataset.screen===screen));
  window.scrollTo(0,0);
  if(screen==="dashboard")renderDashboard();
  if(screen==="customers")renderCustomers();
  if(screen==="loans")renderLoans();
  if(screen==="collection")renderPayments();
  if(screen==="expenses")renderExpenses();
  if(screen==="reports")renderReports();
  if(screen==="settings")renderSettings();
}
$$(".nav-item").forEach(b=>b.onclick=()=>navigate(b.dataset.screen));
$$("[data-screen]").forEach(b=>{if(!b.classList.contains("nav-item"))b.onclick=()=>navigate(b.dataset.screen)});

function customerForm(customer={}){
  return `<form id="customerForm">
    <div class="form-grid">
      <div class="field full"><label>Name *</label><input name="name" required value="${esc(customer.name||"")}" autocomplete="name"></div>
      <div class="field"><label>Mobile</label><input name="mobile" inputmode="numeric" maxlength="15" value="${esc(customer.mobile||"")}"></div>
      <div class="field"><label>Customer ID</label><input value="${esc(customer.id||"Auto generated")}" disabled></div>
    </div>
    <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn">Save Customer</button></div>
  </form>`;
}
function openCustomer(customer){
  showModal(customer?"Edit Customer":"Add Customer",customerForm(customer));
  $("#customerForm").onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.target), name=String(fd.get("name")).trim(), mobile=String(fd.get("mobile")).trim();
    if(!name){showToast("Name required");return}
    if(customer){
      customer.name=name;customer.mobile=mobile;customer.updatedAt=Date.now();await put("customers",customer);
    }else{
      const same=state.customers.find(c=>mobile && c.mobile===mobile);
      if(same){showToast("This mobile already belongs to "+same.name);return}
      const c={id:uid("CUST"),name,mobile,createdAt:Date.now(),updatedAt:Date.now()};
      await put("customers",c);state.customers.push(c);
    }
    await refresh();closeModal();navigate("customers");showToast("Customer saved");
  };
}

function loanForm(loan={}){
  const plans=getSettings().plans||DEFAULT_SETTINGS.plans;
  const selectedCustomer=customerById(loan.customerId);
  return `<form id="loanForm">
  <div class="form-grid">
    <div class="field full"><label>Customer *</label>
      <select name="customerId" required>${state.customers.map(c=>`<option value="${c.id}" ${c.id===loan.customerId?"selected":""}>${esc(c.name)} — ${esc(c.mobile||"No mobile")} — ${c.id}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Loan Plan *</label><select name="amount" id="loanAmount">${plans.map(p=>`<option value="${p.amount}" ${Number(p.amount)===Number(loan.principal)?"selected":""}>${esc(p.name)} — ${p.days} days</option>`).join("")}<option value="custom" ${!plans.some(p=>Number(p.amount)===Number(loan.principal))?"selected":""}>Custom</option></select></div>
    <div class="field"><label>Custom Amount</label><input name="customAmount" id="customAmount" type="number" min="0" step="0.01" value="${plans.some(p=>Number(p.amount)===Number(loan.principal))?"":(loan.principal||"")}"></div>
    <div class="field"><label>Cut %</label><input name="cut" id="loanCut" type="number" min="0" max="100" step="0.01" value="${loan.cutPercent??20}"></div>
    <div class="field"><label>Collection Days</label><input name="days" id="loanDays" type="number" min="1" value="${loan.days||30}"></div>
    <div class="field"><label>Start Date *</label><input name="startDate" type="date" required value="${loan.startDate||isoToday()}"></div>
    <div class="field"><label>Penalty / late day</label><input name="penaltyDefault" type="number" min="0" step="0.01" value="${loan.penaltyDefault||0}"></div>
    <div class="field"><label>Penalty enabled</label><select name="penaltyEnabled"><option value="yes" ${loan.penaltyEnabled!==false?"selected":""}>Yes</option><option value="no" ${loan.penaltyEnabled===false?"selected":""}>No</option></select></div>
    <div class="field full"><label>Notes</label><textarea name="notes">${esc(loan.notes||"")}</textarea></div>
  </div>
  <div id="loanPreview" class="report-box"></div>
  <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn">${loan?"Save Loan":"Create Loan"}</button></div>
  </form>`;
}

function bindLoanPreview(existing){
  const amount=$("#loanAmount"), custom=$("#customAmount"), cut=$("#loanCut"), days=$("#loanDays"), preview=$("#loanPreview");
  function update(){
    let a=amount.value==="custom"?num(custom.value):num(amount.value);
    const p=(getSettings().plans||[]).find(x=>Number(x.amount)===a);
    if(p && amount.value!=="custom" && !existing){cut.value=p.cut;days.value=p.days}
    const net=a*(1-num(cut.value)/100), daily=num(days.value)?net/num(days.value):0;
    preview.innerHTML=`<div class="report-lines"><div class="report-line"><span>Principal</span><b>${money(a)}</b></div><div class="report-line"><span>20%/configured cut</span><b>${money(a*num(cut.value)/100)}</b></div><div class="report-line"><span>Main collection amount</span><b>${money(net)}</b></div><div class="report-line"><span>Daily due</span><b>${money(daily)}</b></div></div>`;
  }
  [amount,custom,cut,days].forEach(x=>x.oninput=update);update();
}

function openLoan(loan={}){
  if(!state.customers.length){showToast("Add a customer first");navigate("customers");return}
  showModal(loan.id?"Edit Loan":"New Loan",loanForm(loan));
  bindLoanPreview(loan.id?loan:null);
  $("#loanForm").onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.target);
    let principal=fd.get("amount")==="custom"?num(fd.get("customAmount")):num(fd.get("amount"));
    const customerId=fd.get("customerId"), cut=num(fd.get("cut")), days=Math.max(1,Math.floor(num(fd.get("days"))));
    if(!principal||!customerId){showToast("Customer and amount required");return}
    const net=principal*(1-cut/100), daily=net/days;
    if(loan.id){
      loan.customerId=customerId;loan.principal=principal;loan.cutPercent=cut;loan.cutAmount=principal*cut/100;loan.netCollectionAmount=net;loan.days=days;loan.dailyDue=daily;loan.startDate=fd.get("startDate");loan.penaltyDefault=num(fd.get("penaltyDefault"));loan.penaltyEnabled=fd.get("penaltyEnabled")==="yes";loan.notes=fd.get("notes");loan.updatedAt=Date.now();
      await put("loans",loan);
    }else{
      const l={id:uid("LOAN"),customerId,principal,cutPercent:cut,cutAmount:principal*cut/100,netCollectionAmount:net,days,dailyDue:daily,startDate:fd.get("startDate"),penaltyDefault:num(fd.get("penaltyDefault")),penaltyEnabled:fd.get("penaltyEnabled")==="yes",notes:fd.get("notes"),status:"active",createdAt:Date.now(),updatedAt:Date.now()};
      await put("loans",l);state.loans.push(l);
    }
    await refresh();closeModal();navigate("loans");showToast(loan.id?"Loan updated":"New Loan created");
  };
}

function paymentForm(payment={}){
  const activeLoans=state.loans.filter(l=>loanStatus(l)!=="archived");
  return `<form id="paymentForm"><div class="form-grid">
    <div class="field full"><label>Loan *</label><select name="loanId" id="paymentLoan" required>${activeLoans.map(l=>{const c=customerById(l.customerId);return `<option value="${l.id}" ${l.id===payment.loanId?"selected":""}>${esc(c?.name||"")} — ${l.id} — ${money(l.principal)}</option>`}).join("")}</select></div>
    <div class="field"><label>Date *</label><input name="date" type="date" required value="${payment.date||isoToday()}"></div>
    <div class="field"><label>Actual Payment</label><input name="actual" type="number" min="0" step="0.01" value="${payment.actual??""}"></div>
    <div class="field"><label>Manual Adjustment (+/-)</label><input name="adjustment" type="number" step="0.01" value="${payment.adjustment||0}"></div>
    <div class="field"><label>Penalty</label><input name="penalty" id="paymentPenalty" type="number" min="0" step="0.01" value="${payment.penalty??0}"></div>
    <div class="field full"><label>Note</label><textarea name="note">${esc(payment.note||"")}</textarea></div>
  </div><div id="paymentPreview" class="report-box"></div>
  <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn">Save Payment</button></div></form>`;
}
function paymentPreview(){
  const loan=loanById($("#paymentLoan")?.value);if(!loan)return;
  const date=$('[name="date"]')?.value||isoToday();const t=loanTotals(loan,date);
  const actual=num($('[name="actual"]')?.value), adj=Number($('[name="adjustment"]')?.value||0), penalty=num($("#paymentPenalty")?.value);
  const scheduled=t.days>=loan.days?0:loan.dailyDue;
  const currentPayable=scheduled+t.outstanding+penalty;
  const after=Math.max(0,currentPayable-actual-adj);
  $("#paymentPreview").innerHTML=`<div class="report-lines"><div class="report-line"><span>Today's scheduled due</span><b>${money(scheduled)}</b></div><div class="report-line"><span>Previous outstanding</span><b>${money(t.outstanding)}</b></div><div class="report-line"><span>Total due before payment</span><b>${money(currentPayable)}</b></div><div class="report-line"><span>Outstanding after</span><b>${money(after)}</b></div></div>`;
}
function openPayment(payment={}){
  if(!state.loans.filter(l=>loanStatus(l)!=="archived").length){showToast("No active loan");navigate("loans");return}
  showModal(payment.id?"Edit Payment":"Record Payment",paymentForm(payment));
  ["#paymentLoan",'[name="date"]','[name="actual"]','[name="adjustment"]','#paymentPenalty'].forEach(s=>$(s)?.addEventListener("input",paymentPreview));
  paymentPreview();
  $("#paymentForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.target), loan=loanById(fd.get("loanId"));if(!loan)return;
    const date=fd.get("date"), actual=num(fd.get("actual")), adjustment=Number(fd.get("adjustment")||0), penalty=num(fd.get("penalty"));
    const existing=state.payments.filter(p=>p.loanId===loan.id&&p.date===date&&p.id!==payment.id);
    if(existing.length){showToast("A payment already exists for this loan/date. Edit it instead.");return}
    const t=loanTotals(loan,date), scheduled=t.days>=loan.days?0:loan.dailyDue, due=scheduled+t.outstanding+penalty, after=Math.max(0,due-actual-adjustment);
    const p=payment.id?payment:{id:uid("PAY"),createdAt:Date.now()};
    p.loanId=loan.id;p.date=date;p.expected=scheduled;p.previousOutstanding=t.outstanding;p.actual=actual;p.adjustment=adjustment;p.penalty=loan.penaltyEnabled?penalty:0;p.totalDue=due;p.outstandingAfter=after;p.short=Math.max(0,due-actual-adjustment);p.extra=Math.max(0,actual+adjustment-due);p.status=actual+adjustment>=due?"Paid":actual+adjustment>0?"Short Paid":"Unpaid";p.note=fd.get("note");p.updatedAt=Date.now();
    await put("payments",p);await refresh();closeModal();navigate("collection");showToast("Payment saved");
  };
}

function expenseForm(exp={}){
  return `<form id="expenseForm"><div class="form-grid">
    <div class="field"><label>Date *</label><input name="date" type="date" required value="${exp.date||isoToday()}"></div>
    <div class="field"><label>Amount *</label><input name="amount" type="number" min="0" step="0.01" required value="${exp.amount??""}"></div>
    <div class="field full"><label>Description *</label><input name="description" required value="${esc(exp.description||"")}"></div>
    <div class="field full"><label>Contact / WhatsApp</label><input name="contact" inputmode="tel" value="${esc(exp.contact||"")}"></div>
  </div><div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn">Save Expense</button></div></form>`;
}
function openExpense(exp={}){
  showModal(exp.id?"Edit Expense":"Add Expense",expenseForm(exp));
  $("#expenseForm").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);const x=exp.id?exp:{id:uid("EXP"),createdAt:Date.now()};x.date=fd.get("date");x.amount=num(fd.get("amount"));x.description=String(fd.get("description")).trim();x.contact=String(fd.get("contact")).trim();x.updatedAt=Date.now();await put("expenses",x);await refresh();closeModal();navigate("expenses");showToast("Expense saved")};
}

function renderDashboard(){
  $("#todayLabel").textContent=new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long"});
  const d=isoToday(), pays=state.payments.filter(p=>p.date===d), exps=state.expenses.filter(e=>e.date===d);
  const collection=pays.reduce((s,p)=>s+num(p.actual),0), expense=exps.reduce((s,e)=>s+num(e.amount),0);
  const active=state.loans.filter(l=>loanStatus(l)!=="archived");
  let expected=0,out=0,pen=0;
  active.forEach(l=>{const t=loanTotals(l);expected+=Math.min(l.dailyDue, Math.max(0,l.dailyDue));out+=t.outstanding;pen+=t.penalties});
  const pending=Math.max(0,expected-collection);
  $("#statCollection").textContent=money(collection);$("#statExpense").textContent=money(expense);$("#statPending").textContent=money(pending);$("#statOutstanding").textContent=money(out);$("#statPenalty").textContent=money(pen);$("#statNet").textContent=money(collection-expense);
  const todays=active.filter(l=>{const t=loanTotals(l);return d>=l.startDate && t.days<l.days});
  $("#todayLoans").innerHTML=todays.length?todays.slice(0,12).map(loanCard).join(""):`<div class="empty">No active collection due shown for today.</div>`;
}
function loanCard(l){
  const c=customerById(l.customerId),t=loanTotals(l),s=loanStatus(l);
  return `<div class="card"><div class="card-top"><div><div class="card-title">${esc(c?.name||"Unknown")}</div><div class="card-sub">${esc(l.id)} · ${esc(c?.mobile||"")}</div></div>${statusPill(s)}</div>
  <div class="card-grid"><div class="metric"><span>Loan</span><b>${money(l.principal)}</b></div><div class="metric"><span>Daily</span><b>${money(l.dailyDue)}</b></div><div class="metric"><span>Collected</span><b>${money(t.collected)}</b></div><div class="metric"><span>Outstanding</span><b>${money(t.outstanding)}</b></div></div>
  <div class="card-actions"><button class="mini-btn green" data-pay="${l.id}">Collect</button><button class="mini-btn blue" data-viewloan="${l.id}">View</button><button class="mini-btn" data-wa="${l.id}">WhatsApp</button></div></div>`;
}
function bindCards(root=document){
  $$("[data-pay]",root).forEach(b=>b.onclick=()=>openPayment({loanId:b.dataset.pay}));
  $$("[data-viewloan]",root).forEach(b=>b.onclick=()=>openLoan(loanById(b.dataset.viewloan)));
  $$("[data-wa]",root).forEach(b=>b.onclick=()=>whatsappLoan(b.dataset.wa,"unpaid"));
  $$("[data-editcustomer]",root).forEach(b=>b.onclick=()=>openCustomer(customerById(b.dataset.editcustomer)));
  $$("[data-customerloans]",root).forEach(b=>showCustomerDetail(b.dataset.customerloans));
  $$("[data-editpayment]",root).forEach(b=>openPayment(state.payments.find(p=>p.id===b.dataset.editpayment)));
  $$("[data-editexpense]",root).forEach(b=>openExpense(state.expenses.find(p=>p.id===b.dataset.editexpense)));
}

function renderCustomers(){
  const q=($("#customerSearch").value||"").toLowerCase().trim();
  const list=state.customers.filter(c=>`${c.name} ${c.mobile||""} ${c.id}`.toLowerCase().includes(q));
  $("#customerList").innerHTML=list.length?list.map(c=>{
    const loans=state.loans.filter(l=>l.customerId===c.id),active=loans.filter(l=>loanStatus(l)!=="archived"),arch=loans.filter(l=>loanStatus(l)==="archived");
    return `<div class="card"><div class="card-top"><div><div class="card-title">${esc(c.name)}</div><div class="card-sub">${esc(c.mobile||"No mobile")} · ${c.id}</div></div><span class="pill blue">${active.length} active</span></div>
    <div class="card-grid"><div class="metric"><span>Active loans</span><b>${active.length}</b></div><div class="metric"><span>Archived loans</span><b>${arch.length}</b></div></div>
    <div class="card-actions"><button class="mini-btn blue" data-customerloans="${c.id}">View loans</button><button class="mini-btn" data-editcustomer="${c.id}">Edit</button>${c.mobile?`<button class="mini-btn green" onclick="window.open('https://wa.me/${normalizePhone(c.mobile)}','_blank')">WhatsApp</button>`:""}</div></div>`
  }).join(""):`<div class="empty">No customers found.</div>`;
  bindCards($("#customerList"));
}
function showCustomerDetail(id){
  const c=customerById(id),loans=state.loans.filter(l=>l.customerId===id);
  if(!c)return;
  showModal(c.name,`<div class="card-sub">${esc(c.mobile||"No mobile")} · ${c.id}</div><div class="section-head"><h2>All loans</h2><button class="mini-btn green" id="newLoanForCustomer">+ New Loan</button></div><div class="card-list">${loans.length?loans.map(loanCard).join(""):`<div class="empty">No loans yet.</div>`}</div>`);
  $("#newLoanForCustomer").onclick=()=>{closeModal();openLoan({customerId:id})};bindCards($("#modalRoot"));
}

function renderLoans(){
  const q=($("#loanSearch").value||"").toLowerCase().trim();
  let list=state.loans.filter(l=>{const s=loanStatus(l);return loanFilter==="active"?s!=="archived":loanFilter==="archive"?s==="archived":true});
  list=list.filter(l=>{const c=customerById(l.customerId);return `${l.id} ${c?.name||""} ${c?.mobile||""} ${l.principal}`.toLowerCase().includes(q)});
  $("#loanList").innerHTML=list.length?list.map(l=>{
    const t=loanTotals(l),s=loanStatus(l);
    return `<div class="card"><div class="card-top"><div><div class="card-title">${esc(customerName(l.customerId))}</div><div class="card-sub">${l.id} · ${fmtDate(l.startDate)} · ${money(l.principal)}</div></div>${statusPill(s)}</div>
    <div class="card-grid"><div class="metric"><span>Main collection</span><b>${money(l.netCollectionAmount)}</b></div><div class="metric"><span>Daily due</span><b>${money(l.dailyDue)}</b></div><div class="metric"><span>Collected</span><b>${money(t.collected)}</b></div><div class="metric"><span>Outstanding</span><b>${money(t.outstanding)}</b></div><div class="metric"><span>Penalty</span><b>${money(t.penalties)}</b></div><div class="metric"><span>Days</span><b>${t.completedDays}/${l.days}</b></div></div>
    <div class="card-actions"><button class="mini-btn green" data-pay="${l.id}">Payment</button><button class="mini-btn blue" data-viewloan="${l.id}">Edit</button><button class="mini-btn" data-loan-history="${l.id}">History</button>${s==="completed"?`<button class="mini-btn green" data-archive="${l.id}">Archive</button>`:""}${s==="archived"?`<button class="mini-btn blue" data-restore="${l.id}">Restore</button>`:""}</div></div>`
  }).join(""):`<div class="empty">No loans found.</div>`;
  bindCards($("#loanList"));
  $$("[data-loan-history]",$("#loanList")).forEach(b=>showLoanHistory.bind(null,b.dataset.loanHistory) && (b.onclick=()=>showLoanHistory(b.dataset.loanHistory)));
  $$("[data-archive]",$("#loanList")).forEach(b=>b.onclick=()=>archiveLoan(b.dataset.archive));
  $$("[data-restore]",$("#loanList")).forEach(b=>b.onclick=()=>restoreLoan(b.dataset.restore));
}
function showLoanHistory(id){
  const l=loanById(id), c=customerById(l.customerId), t=loanTotals(l,"9999-12-31");
  const pays=t.payments;
  showModal(`${c?.name||""} — ${id}`,`<div class="card-grid"><div class="metric"><span>Principal</span><b>${money(l.principal)}</b></div><div class="metric"><span>Daily</span><b>${money(l.dailyDue)}</b></div><div class="metric"><span>Collected</span><b>${money(t.collected)}</b></div><div class="metric"><span>Outstanding</span><b>${money(t.outstanding)}</b></div></div><div class="section-head"><h2>Payment history</h2></div><div class="card-list">${pays.length?pays.map(p=>`<div class="card"><div class="card-top"><div><b>${fmtDate(p.date)}</b><div class="card-sub">${p.status} · ${p.id}</div></div><b>${money(p.actual)}</b></div><div class="card-sub">Expected ${money(p.expected)} · Adjustment ${money(p.adjustment)} · Penalty ${money(p.penalty)} · Outstanding after ${money(p.outstandingAfter)}</div></div>`).join(""):`<div class="empty">No payments.</div>`}</div>`);
}

async function archiveLoan(id){
  const l=loanById(id),t=loanTotals(l,"9999-12-31");
  if(!t.complete){showToast("Loan cannot be archived while due/outstanding remains");return}
  if(!confirmAction("Archive this loan? It will NOT be deleted and all history will remain safe."))return;
  l.status="archived";l.archivedAt=Date.now();await put("loans",l);await refresh();showToast("Loan archived safely");
}
async function restoreLoan(id){
  const l=loanById(id);if(!confirmAction("Restore this loan to active records? History will remain unchanged."))return;
  l.status="active";l.archivedAt=null;l.updatedAt=Date.now();await put("loans",l);await refresh();showToast("Loan restored");
}

function renderPayments(){
  const q=($("#paymentSearch").value||"").toLowerCase().trim();
  const list=[...state.payments].sort((a,b)=>b.date.localeCompare(a.date)).filter(p=>{const l=loanById(p.loanId),c=l&&customerById(l.customerId);return `${p.date} ${p.loanId} ${c?.name||""} ${c?.mobile||""}`.toLowerCase().includes(q)});
  const today=isoToday(),tp=state.payments.filter(p=>p.date===today),exp=state.loans.filter(l=>loanStatus(l)!=="archived").reduce((s,l)=>s+loanDailyDue(l),0);
  const collected=tp.reduce((s,p)=>s+num(p.actual),0);
  $("#colExpected").textContent=money(exp);$("#colCollected").textContent=money(collected);$("#colPending").textContent=money(Math.max(0,exp-collected));
  $("#paymentList").innerHTML=list.length?list.map(p=>{const l=loanById(p.loanId),c=l&&customerById(l.customerId);return `<div class="card"><div class="card-top"><div><div class="card-title">${esc(c?.name||"Unknown")}</div><div class="card-sub">${p.loanId} · ${fmtDate(p.date)}</div></div><span class="pill ${p.status==="Paid"?"green":p.status==="Short Paid"?"yellow":"red"}">${esc(p.status)}</span></div><div class="card-grid"><div class="metric"><span>Expected</span><b>${money(p.expected)}</b></div><div class="metric"><span>Actual</span><b>${money(p.actual)}</b></div><div class="metric"><span>Adjustment</span><b>${money(p.adjustment)}</b></div><div class="metric"><span>Outstanding</span><b>${money(p.outstandingAfter)}</b></div></div><div class="card-actions"><button class="mini-btn blue" data-editpayment="${p.id}">Edit</button><button class="mini-btn green" onclick="whatsappPayment('${p.id}')">Paid WhatsApp</button><button class="mini-btn" onclick="whatsappPayment('${p.id}','unpaid')">Reminder</button></div></div>`}).join(""):`<div class="empty">No payment records.</div>`;
  bindCards($("#paymentList"));
}

function renderExpenses(){
  const q=$("#expenseDateFilter").value;
  let list=[...state.expenses].sort((a,b)=>b.date.localeCompare(a.date));
  if(q)list=list.filter(x=>x.date===q);
  $("#expenseTotal").textContent=money(list.reduce((s,x)=>s+num(x.amount),0));
  $("#expenseList").innerHTML=list.length?list.map(x=>`<div class="card"><div class="card-top"><div><div class="card-title">${esc(x.description)}</div><div class="card-sub">${fmtDate(x.date)}${x.contact?" · "+esc(x.contact):""}</div></div><b>${money(x.amount)}</b></div><div class="card-actions"><button class="mini-btn blue" data-editexpense="${x.id}">Edit</button>${x.contact?`<button class="mini-btn green" onclick="whatsappNumber('${normalizePhone(x.contact)}')">WhatsApp</button>`:""}</div></div>`).join(""):`<div class="empty">No expenses.</div>`;
  bindCards($("#expenseList"));
}

function periodMatch(date,period,base){
  if(period==="all")return true;
  if(period==="day")return date===base;
  if(period==="month")return date.slice(0,7)===base.slice(0,7);
  return date.slice(0,4)===base.slice(0,4);
}
function renderReports(){
  const period=$("#reportPeriod").value, base=$("#reportDate").value||isoToday();
  const pays=state.payments.filter(p=>periodMatch(p.date,period,base)), exps=state.expenses.filter(x=>periodMatch(x.date,period,base));
  const collection=pays.reduce((s,p)=>s+num(p.actual),0), expenses=exps.reduce((s,p)=>s+num(p.amount),0), penalties=pays.reduce((s,p)=>s+num(p.penalty),0),adjust=pays.reduce((s,p)=>s+Number(p.adjustment||0),0),out=state.loans.filter(l=>loanStatus(l)!=="archived").reduce((s,l)=>s+loanTotals(l).outstanding,0);
  $("#reportSummary").innerHTML=`<div class="report-lines"><div class="report-line"><span>Period</span><b>${period==="day"?fmtDate(base):period==="month"?base.slice(0,7):period==="year"?base.slice(0,4):"All time"}</b></div><div class="report-line"><span>Total collection</span><b>${money(collection)}</b></div><div class="report-line"><span>Total expenses</span><b>${money(expenses)}</b></div><div class="report-line"><span>Net remaining</span><b>${money(collection-expenses)}</b></div><div class="report-line"><span>Penalty recorded</span><b>${money(penalties)}</b></div><div class="report-line"><span>Adjustments</span><b>${money(adjust)}</b></div><div class="report-line"><span>Current outstanding</span><b>${money(out)}</b></div></div>`;
  $("#reportLoans").innerHTML=state.loans.filter(l=>loanStatus(l)!=="archived").map(l=>{const t=loanTotals(l),c=customerById(l.customerId);return `<div class="card"><div class="card-top"><div><b>${esc(c?.name||"")}</b><div class="card-sub">${l.id}</div></div>${statusPill(loanStatus(l))}</div><div class="card-grid"><div class="metric"><span>Expected to date</span><b>${money(t.expected)}</b></div><div class="metric"><span>Collected</span><b>${money(t.collected)}</b></div><div class="metric"><span>Outstanding</span><b>${money(t.outstanding)}</b></div><div class="metric"><span>Penalty</span><b>${money(t.penalties)}</b></div></div></div>`}).join("")||`<div class="empty">No active loans.</div>`;
}

function renderSettings(){
  const plans=getSettings().plans||DEFAULT_SETTINGS.plans;
  $("#planEditor").innerHTML=plans.map((p,i)=>`<div class="plan-row"><input data-plan-name="${i}" value="${esc(p.name)}"><input data-plan-amount="${i}" type="number" value="${p.amount}"><input data-plan-days="${i}" type="number" value="${p.days}"><input data-plan-cut="${i}" type="number" value="${p.cut}"></div>`).join("");
  $("#storageStatus").textContent="IndexedDB";
  $("#safeCustomers").textContent=state.customers.length;$("#safeLoans").textContent=state.loans.length;$("#safePayments").textContent=state.payments.length;$("#safeExpenses").textContent=state.expenses.length;
}

async function savePlans(){
  const plans=(getSettings().plans||[]).map((p,i)=>({...p,name:$(`[data-plan-name="${i}"]`).value.trim()||p.name,amount:num($(`[data-plan-amount="${i}"]`).value),days:Math.max(1,Math.floor(num($(`[data-plan-days="${i}"]`).value))),cut:num($(`[data-plan-cut="${i}"]`).value)}));
  const s=getSettings();s.plans=plans;s.updatedAt=Date.now();await put("settings",s);await refresh();showToast("Plans saved. Existing loans are unchanged.");
}
async function refresh(){for(const s of STORES)state[s]=await getAll(s);renderAll()}
function renderAll(){renderDashboard();renderCustomers();renderLoans();renderPayments();renderExpenses();renderReports();renderSettings()}

function normalizePhone(p){let x=String(p||"").replace(/\D/g,"");if(x.startsWith("0"))x=x.slice(1);if(x.length===10)x="91"+x;return x}
function openWhatsApp(number,text){const n=normalizePhone(number);if(!n){showToast("Mobile number missing");return}window.open(`https://wa.me/${n}?text=${encodeURIComponent(text||"")}`,"_blank")}
function whatsappNumber(number){openWhatsApp(number,"")}
function whatsappLoan(id,type="unpaid"){
  const l=loanById(id),c=customerById(l.customerId),t=loanTotals(l),due=Math.max(0,l.dailyDue+t.outstanding);
  const text=type==="paid"?`Hello ${c?.name||""}, your payment for Loan ID ${l.id} has been recorded. Thank you.`:`Hello ${c?.name||""}, reminder for Loan ID ${l.id}. Amount due/outstanding: ${money(due)}. Please make the payment today.`;
  openWhatsApp(c?.mobile,text);
}
function whatsappPayment(id,type="paid"){
  const p=state.payments.find(x=>x.id===id),l=p&&loanById(p.loanId),c=l&&customerById(l.customerId);if(!p||!l)return;
  const text=type==="paid"?`Hello ${c?.name||""}, payment of ${money(p.actual)} for Loan ID ${l.id} on ${fmtDate(p.date)} has been recorded. Thank you.`:`Hello ${c?.name||""}, payment reminder for Loan ID ${l.id}. Outstanding after the latest record: ${money(p.outstandingAfter)}.`;
  openWhatsApp(c?.mobile,text);
}
window.whatsappLoan=whatsappLoan;window.whatsappPayment=whatsappPayment;window.whatsappNumber=whatsappNumber;

function csvEscape(v){const s=String(v??"");return `"${s.replace(/"/g,'""')}"`}
function downloadText(name,text,type="text/plain"){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function rowsCsv(headers,rows){return [headers,...rows].map(r=>r.map(csvEscape).join(",")).join("\n")}
function exportAllCsv(){
  const sections=[];
  sections.push("CUSTOMERS\n"+rowsCsv(["Customer ID","Name","Mobile","Created"],state.customers.map(c=>[c.id,c.name,c.mobile,fmtDate(new Date(c.createdAt).toISOString().slice(0,10))])));
  sections.push("LOANS\n"+rowsCsv(["Loan ID","Customer ID","Principal","Cut %","Net Collection","Days","Daily Due","Start","Status"],state.loans.map(l=>[l.id,l.customerId,l.principal,l.cutPercent,l.netCollectionAmount,l.days,l.dailyDue,l.startDate,loanStatus(l)])));
  sections.push("PAYMENTS\n"+rowsCsv(["Payment ID","Loan ID","Date","Expected","Actual","Adjustment","Penalty","Outstanding After","Status"],state.payments.map(p=>[p.id,p.loanId,p.date,p.expected,p.actual,p.adjustment,p.penalty,p.outstandingAfter,p.status])));
  sections.push("EXPENSES\n"+rowsCsv(["Expense ID","Date","Description","Amount","Contact"],state.expenses.map(x=>[x.id,x.date,x.description,x.amount,x.contact])));
  downloadText("shailu-bhai-all-data.csv",sections.join("\n\n"),"text/csv;charset=utf-8");
  showToast("All data exported as CSV");
}
function exportReportCsv(){
  const rows=[["Type","ID","Date","Customer","Amount","Status"]];
  state.payments.forEach(p=>{const l=loanById(p.loanId);rows.push(["Payment",p.id,p.date,customerName(l?.customerId),p.actual,p.status])});
  state.expenses.forEach(e=>rows.push(["Expense",e.id,e.date,e.description,-e.amount,"Expense"]));
  downloadText("shailu-bhai-report.csv",rowsCsv(rows.shift(),rows),"text/csv;charset=utf-8");showToast("Report exported");
}
function backup(){
  const data={app:"Shailu Bhai Daily Collection Manager",schema:1,exportedAt:new Date().toISOString(),customers:state.customers,loans:state.loans,payments:state.payments,expenses:state.expenses,settings:getSettings()};
  downloadText(`shailu-bhai-backup-${isoToday()}.json`,JSON.stringify(data,null,2),"application/json");
  showToast("Backup downloaded");
}
async function restore(file){
  try{
    const data=JSON.parse(await file.text());
    if(!data || !Array.isArray(data.customers)||!Array.isArray(data.loans)||!Array.isArray(data.payments)||!Array.isArray(data.expenses))throw new Error("Invalid backup");
    if(!confirmAction("Restore backup? Current data will be replaced by the selected backup. Make a backup first if needed."))return;
    for(const s of ["customers","loans","payments","expenses","settings"])await clearStore(s);
    for(const x of data.customers)await put("customers",x);
    for(const x of data.loans)await put("loans",x);
    for(const x of data.payments)await put("payments",x);
    for(const x of data.expenses)await put("expenses",x);
    await put("settings",data.settings||{id:"app",plans:cloneData(DEFAULT_SETTINGS.plans)});
    await refresh();showToast("Backup restored successfully");
  }catch(e){console.error(e);showToast("Backup file is invalid")}
}

function printReport(){window.print()}
async function shareReport(){
  const text=`Shailu Bhai Report — ${isoToday()}\nCollection: ${$("#statCollection").textContent}\nExpenses: ${$("#statExpense").textContent}\nNet: ${$("#statNet").textContent}`;
  if(navigator.share){try{await navigator.share({title:"Shailu Bhai Report",text})}catch{}}
  else{await navigator.clipboard?.writeText(text);showToast("Report copied")}
}

$("#addCustomerBtn").onclick=()=>openCustomer();
$("#addLoanBtn").onclick=()=>openLoan();
$("#addPaymentBtn").onclick=()=>openPayment();
$("#addExpenseBtn").onclick=()=>openExpense();
$("#quickCollectBtn").onclick=()=>openPayment();
$("#backupQuickBtn").onclick=backup;
$("#backupBtn").onclick=backup;
$("#restoreBtn").onclick=()=>$("#restoreFile").click();
$("#restoreFile").onchange=e=>{if(e.target.files[0])restore(e.target.files[0]);e.target.value=""};
$("#exportAllCsvBtn").onclick=exportAllCsv;
$("#exportCsvBtn").onclick=exportReportCsv;
$("#printReportBtn").onclick=printReport;
$("#shareReportBtn").onclick=shareReport;
$("#savePlansBtn").onclick=savePlans;
$("#customerSearch").oninput=renderCustomers;
$("#loanSearch").oninput=renderLoans;
$("#paymentSearch").oninput=renderPayments;
$("#expenseDateFilter").oninput=renderExpenses;
$("#clearExpenseFilter").onclick=()=>{$("#expenseDateFilter").value="";renderExpenses()};
$("#reportPeriod").onchange=renderReports;$("#reportDate").onchange=renderReports;
$$("[data-loan-filter]").forEach(b=>b.onclick=()=>{$$("[data-loan-filter]").forEach(x=>x.classList.remove("active"));b.classList.add("active");loanFilter=b.dataset.loanFilter;renderLoans()});
$("#resetBtn").onclick=async()=>{
  if(!confirmAction("This will permanently clear local app data. Continue only if you already have a backup."))return;
  if(!confirmAction("FINAL CONFIRMATION: delete all local data?"))return;
  for(const s of STORES)await clearStore(s);await load();showToast("Local data reset");
};

window.addEventListener("beforeunload",()=>{});
window.addEventListener("error",e=>console.error(e.error||e.message));
window.addEventListener("unhandledrejection",e=>console.error(e.reason));

load().catch(e=>{console.error(e);showToast("Storage could not be opened")});
})();
