const http = require('node:http');
const fs = require('node:fs/promise');
const path = require('node:path');

const PORT = Number(process.env.PORT || 4173);
const DB_PATH = path.join(__dirname, 'data.json');
let db;
let persistQueue = Promise.resolve();

async function getDb() {
  if (!db) db = JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2) + '\n';
  persistQueue = persistQueue.then(() => fs.writeFile(DB_PATH, snapshot, 'utf8'));
  return persistQueue;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function safeToSpend(data) {
  const draftTotal = data.orders.filter(o => o.status === 'draft').reduce((s, o) => s + o.total, 0);
  return Math.max(0, data.merchant.cashAvailable - data.merchant.supplierDues - data.merchant.upcomingExpenses - data.merchant.operatingBuffer - draftTotal);
}

function dashboard(data) {
  const reminderTarget = data.customers.reduce((s, c) => s + c.balance, 0);
  const totalMonthlySaving = data.marginLeaks.reduce((s, m) => s + m.monthlySaving, 0);
  return {
    merchant: data.merchant,
    safeToSpend: safeToSpend(data),
    committedCash: data.merchant.cashAvailable - safeToSpend(data),
    reminderCount: data.customers.filter(c => c.daysOverdue > c.usualPayDays).length,
    reminderTarget,
    totalMonthlySaving,
    supplierSavingPerOrder: (data.supplierComparison.usualSupplier.unitPrice - data.supplierComparison.alternativeSupplier.unitPrice) * data.supplierComparison.units,
    products: data.products,
    customers: data.customers.slice(0, 3),
    draftOrders: data.orders.filter(o => o.status === 'draft')
  };
}

function cashflowSummary(data) {
  const m = data.merchant;
  return {
    cashAvailable: m.cashAvailable,
    upiIncome: m.upiIncome,
    cashIncome: m.cashIncome,
    creditCollected: m.creditCollected,
    totalIncome: m.upiIncome + m.cashIncome + m.creditCollected,
    supplierDues: m.supplierDues,
    upcomingExpenses: m.upcomingExpenses,
    operatingBuffer: m.operatingBuffer,
    safeToSpend: safeToSpend(data),
    customerReceivables: m.customerReceivables,
    expenseBreakdown: {
      rent: m.rentExpense,
      staff: m.staffExpense,
      utilities: m.utilityExpense,
      misc: m.miscExpense
    },
    timeline: data.cashflowTimeline,
    draftOrdersTotal: data.orders.filter(o => o.status === 'draft').reduce((s, o) => s + o.total, 0)
  };
}

function marginSummary(data) {
  const totalMonthlySaving = data.marginLeaks.reduce((s, m) => s + m.monthlySaving, 0);
  return {
    totalMonthlySaving,
    leakCount: data.marginLeaks.length,
    leaks: data.marginLeaks
  };
}

function insightsSummary(data) {
  const m = data.merchant;
  const safe = safeToSpend(data);
  const reorderProducts = data.products.filter(p => p.status === 'reorder');
  const slowProducts = data.products.filter(p => p.status === 'slow');
  const overdueCustomers = data.customers.filter(c => c.daysOverdue > c.usualPayDays);
  const totalOverdue = overdueCustomers.reduce((s, c) => s + c.balance, 0);
  const totalMonthlySaving = data.marginLeaks.reduce((s, ml) => s + ml.monthlySaving, 0);
  const topLeak = data.marginLeaks.reduce((a, b) => b.monthlySaving > a.monthlySaving ? b : a, data.marginLeaks[0]);
  return {
    cashAgent: {
      safeToSpend: safe,
      cashAvailable: m.cashAvailable,
      supplierDues: m.supplierDues,
      upcomingExpenses: m.upcomingExpenses,
      operatingBuffer: m.operatingBuffer,
      customerReceivables: m.customerReceivables,
      summary: `You have ₹${safe.toLocaleString('en-IN')} safe to spend today. ₹${m.customerReceivables.toLocaleString('en-IN')} more is expected from customer collections.`
    },
    inventoryAgent: {
      reorderCount: reorderProducts.length,
      slowCount: slowProducts.length,
      reorderProducts: reorderProducts.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, stock: p.stock, dailySales: p.dailySales, suggestedOrderQty: p.suggestedOrderQty })),
      slowProducts: slowProducts.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, stock: p.stock, dailySales: p.dailySales })),
      summary: `${reorderProducts.length} products need reordering today. ${slowProducts.length} products are slow-moving — hold off on restocking them.`
    },
    marginAgent: {
      totalMonthlySaving,
      leakCount: data.marginLeaks.length,
      topLeak,
      summary: `You could save ₹${totalMonthlySaving.toLocaleString('en-IN')}/month by switching suppliers on ${data.marginLeaks.length} products. Biggest opportunity: ${topLeak.productName} (₹${topLeak.monthlySaving.toLocaleString('en-IN')}/month).`
    },
    collectionAgent: {
      overdueCount: overdueCustomers.length,
      totalOverdue,
      overdueCustomers: overdueCustomers.map(c => ({ id: c.id, name: c.name, balance: c.balance, daysOverdue: c.daysOverdue, usualPayDays: c.usualPayDays })),
      summary: `${overdueCustomers.length} customers are overdue by more than their usual payment window. Total outstanding: ₹${totalOverdue.toLocaleString('en-IN')}.`
    },
    plannerAgent: {
      recommendation: safe >= 15000
        ? `You have enough headroom. Prioritize the ${reorderProducts.length} reorder products. Keep ₹${m.operatingBuffer.toLocaleString('en-IN')} as buffer.`
        : `Cash is tight. Focus only on the fastest-moving reorder items. Collect ₹${totalOverdue.toLocaleString('en-IN')} from overdue customers first to free up more room.`,
      actions: [
        reorderProducts.length > 0 && `Reorder ${reorderProducts.map(p => p.name).join(', ')}`,
        overdueCustomers.length > 0 && `Send reminders to ${overdueCustomers.length} overdue customers`,
        totalMonthlySaving > 0 && `Review supplier prices — ₹${totalMonthlySaving.toLocaleString('en-IN')}/month potential saving`
      ].filter(Boolean)
    }
  };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Send a valid JSON request body.'), { status: 400 }); }
}

function fmt(v) { return `₹${Math.round(v).toLocaleString('en-IN')}`; }

function reminderMessage(customer, lang) {
  const name = customer.name.replace(/\.$/, '');
  const amt = customer.balance.toLocaleString('en-IN');
  if (lang === 'kn') return `ನಮಸ್ಕಾರ ${name}, ನಿಮ್ಮ ಹಿಂದಿನ ಖರೀದಿಯಿಂದ ₹${amt} ಬಾಕಿ ಇದೆ. ದಯವಿಟ್ಟು ಅನುಕೂಲವಾದಾಗ ಪಾವತಿಸಿ. ಧನ್ಯವಾದಗಳು.`;
  if (lang === 'hi') return `नमस्ते ${name}, आपकी पिछली खरीदारी से ₹${amt} बकाया है। कृपया सुविधानुसार भुगतान करें। धन्यवाद।`;
  return `Hi ${name}, ₹${amt} from your previous purchase is pending. Please clear it when convenient. Thank you.`;
}

function answerQuestion(question, data) {
  const text = String(question || '').trim();
  if (!text) return { answer: 'Ask me about cash, stock, collections, supplier prices, or your overall business health.' };
  const q = text.toLowerCase();
  const safe = safeToSpend(data);
  const m = data.merchant;

  // Collections / customers
  if (/collect|customer|credit|owe|receivable|pending payment|who owes/.test(q)) {
    const overdue = data.customers.filter(c => c.daysOverdue > c.usualPayDays);
    const total = overdue.reduce((s, c) => s + c.balance, 0);
    const worst = overdue.sort((a, b) => b.balance - a.balance)[0];
    return { answer: `${overdue.length} customers are overdue beyond their usual payment window, totalling ${fmt(total)}. ${worst ? `${worst.name} has the largest outstanding amount at ${fmt(worst.balance)}, now ${worst.daysOverdue} days overdue (usually pays in ${worst.usualPayDays} days).` : ''} Sending reminders now could recover this cash within a few days.`, topic: 'collections' };
  }

  // Margin / supplier savings
  if (/supplier|price|cheaper|saving|margin|leak|losing money/.test(q)) {
    const total = data.marginLeaks.reduce((s, ml) => s + ml.monthlySaving, 0);
    const top = data.marginLeaks.reduce((a, b) => b.monthlySaving > a.monthlySaving ? b : a, data.marginLeaks[0]);
    return { answer: `Across ${data.marginLeaks.length} products, you could save ${fmt(total)} per month by switching to cheaper suppliers. The biggest opportunity is ${top.productName}: ${top.betterSupplier} charges ${fmt(top.betterPrice)}/unit vs ${fmt(top.currentPrice)} from ${top.currentSupplier} — saving ${fmt(top.monthlySaving)}/month. Verify quality and availability before switching.`, topic: 'suppliers' };
  }

  // Inventory / stock
  if (/stock|inventory|reorder|dead stock|slow|product/.test(q)) {
    const reorder = data.products.filter(p => p.status === 'reorder');
    const slow = data.products.filter(p => p.status === 'slow');
    if (reorder.length === 0) return { answer: 'All products are well-stocked right now. No reorders needed today.', topic: 'inventory' };
    return { answer: `${reorder.length} products need reordering: ${reorder.map(p => `${p.name} (${p.stock} left, ${p.suggestedOrderQty} suggested)`).join('; ')}. ${slow.length > 0 ? `${slow.length} products are slow-moving (${slow.map(p => p.name).join(', ')}) — hold off on restocking those.` : ''}`, topic: 'inventory' };
  }

  // Cashflow / why did cash decrease
  if (/cash flow|cashflow|why.*cash|cash.*decrease|income|expense/.test(q)) {
    const totalIncome = m.upiIncome + m.cashIncome + m.creditCollected;
    const totalExpense = m.rentExpense + m.staffExpense + m.utilityExpense + m.miscExpense + m.supplierDues;
    return { answer: `This month you earned ${fmt(totalIncome)} (UPI: ${fmt(m.upiIncome)}, cash: ${fmt(m.cashIncome)}, collections: ${fmt(m.creditCollected)}). Outflows were ${fmt(totalExpense)} including ${fmt(m.supplierDues)} to suppliers, ${fmt(m.rentExpense)} rent, and ${fmt(m.staffExpense)} staff. Net cash position: ${fmt(m.cashAvailable)}.`, topic: 'cashflow' };
  }

  // Specific product lookup
  const product = data.products.find(p => q.includes(p.name.toLowerCase()) || p.name.toLowerCase().split(/\s+/).some(w => w.length > 3 && q.includes(w)));
  if (product) {
    if (product.status === 'slow') return { answer: `${product.name} is moving slowly at ${product.dailySales} units/day with ${product.stock} in stock — that's ${(product.stock / product.dailySales).toFixed(0)} days of cover. Hold off on reordering. Consider a small promotion to clear existing stock.`, topic: 'inventory', productId: product.id };
    const days = (product.stock / product.dailySales).toFixed(1);
    return { answer: `${product.name} has ${product.stock} units in stock (~${days} days cover at ${product.dailySales}/day). ${product.status === 'reorder' ? `Suggested order: ${product.suggestedOrderQty} units from ${product.supplier} at ${fmt(product.unitCost)}/unit = ${fmt(product.suggestedOrderQty * product.unitCost)} total.` : 'Stock looks healthy.'}`, topic: 'inventory', productId: product.id };
  }

  // Amount-based spend question
  const amountMatch = q.match(/(?:₹|rs\.?\s*)(\d[\d,]*)|(\d[\d,]*)\s*(?:thousand|k\b|rupees?|lakh)/i);
  let requested = null;
  if (amountMatch) {
    let raw = (amountMatch[1] || amountMatch[2] || '').replaceAll(',', '');
    if (/thousand|k\b/.test(q)) raw = String(Number(raw) * 1000);
    if (/lakh/.test(q)) raw = String(Number(raw) * 100000);
    requested = Number(raw);
  }
  if (requested !== null && requested > 0) {
    if (requested > safe) {
      const reorder = data.products.filter(p => p.status === 'reorder');
      const priorityCost = reorder.reduce((s, p) => s + p.suggestedOrderQty * p.unitCost, 0);
      return { answer: `${fmt(requested)} exceeds your safe-to-spend of ${fmt(safe)} by ${fmt(requested - safe)}. Instead, consider a focused order of ${fmt(Math.min(safe, priorityCost))} covering the ${reorder.length} products that actually need restocking. Collecting ${fmt(m.customerReceivables)} from customers would also increase your available cash.`, topic: 'cashflow', requested, safeToSpend: safe };
    }
    return { answer: `Yes — ${fmt(requested)} fits within your ${fmt(safe)} safe-to-spend. You'd have ${fmt(safe - requested)} left over. Prioritise the ${data.products.filter(p => p.status === 'reorder').length} products flagged for reorder.`, topic: 'cashflow', requested, safeToSpend: safe };
  }

  // General / default
  const reorderCount = data.products.filter(p => p.status === 'reorder').length;
  const overdueCount = data.customers.filter(c => c.daysOverdue > c.usualPayDays).length;
  const totalSaving = data.marginLeaks.reduce((s, ml) => s + ml.monthlySaving, 0);
  return {
    answer: `Here's your business snapshot: ${fmt(safe)} safe to spend today · ${reorderCount} products need reordering · ${overdueCount} customers are overdue · ${fmt(totalSaving)}/month potential saving on supplier prices. Ask me about any of these in detail.`,
    topic: 'overview', safeToSpend: safe
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method || 'GET';
  const data = await getDb();

  if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, dashboard(data));
  if (method === 'GET' && url.pathname === '/api/products') return json(res, 200, data.products);
  if (method === 'GET' && url.pathname === '/api/customers') return json(res, 200, data.customers);
  if (method === 'GET' && url.pathname === '/api/orders') return json(res, 200, data.orders);
  if (method === 'GET' && url.pathname === '/api/suppliers') return json(res, 200, data.suppliers);
  if (method === 'GET' && url.pathname === '/api/cashflow') return json(res, 200, cashflowSummary(data));
  if (method === 'GET' && url.pathname === '/api/margin') return json(res, 200, marginSummary(data));
  if (method === 'GET' && url.pathname === '/api/insights') return json(res, 200, insightsSummary(data));

  if (method === 'POST' && url.pathname === '/api/ask') {
    const body = await readBody(req);
    return json(res, 200, answerQuestion(body.question, data));
  }

  if (method === 'POST' && url.pathname === '/api/orders') {
    const body = await readBody(req);
    const product = data.products.find(p => p.id === body.productId);
    if (!product) return json(res, 404, { error: 'That product was not found.' });
    const quantity = Number(body.quantity ?? product.suggestedOrderQty);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return json(res, 400, { error: 'Order quantity must be a whole number between 1 and 10,000.' });
    const total = quantity * product.unitCost;
    if (total > safeToSpend(data)) return json(res, 409, { error: `This ${fmt(total)} draft exceeds the ${fmt(safeToSpend(data))} currently safe to spend.` });
    const order = { id: `order-${Date.now()}`, productId: product.id, productName: product.name, supplier: product.supplier, quantity, unitCost: product.unitCost, total, status: 'draft', createdAt: new Date().toISOString() };
    data.orders.push(order);
    await persist();
    return json(res, 201, { order, dashboard: dashboard(data) });
  }

  if (method === 'POST' && url.pathname === '/api/reminders/draft') {
    const body = await readBody(req);
    const lang = body.lang || 'en';
    const drafts = data.customers.map(c => ({
      id: `reminder-${c.id}`,
      customerId: c.id,
      customerName: c.name,
      amount: c.balance,
      language: lang === 'auto' ? c.language : lang,
      status: 'draft',
      message: reminderMessage(c, lang === 'auto' ? c.language : lang)
    }));
    data.reminderDrafts = drafts;
    await persist();
    return json(res, 200, { count: drafts.length, total: drafts.reduce((s, d) => s + d.amount, 0), status: 'draft', reminders: drafts });
  }

  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found.' });

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await fs.readFile(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  return json(res, 404, { error: 'Page not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong.' });
    else res.destroy();
    if (!error.status) console.error(error);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`DukaanFlow is running at http://localhost:${PORT}`));
