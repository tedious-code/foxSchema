// FoxSchema demo seed — MongoDB
// One database (foxdb): customers, products, orders. Collections are not
// schemas, so there is no demo_a / demo_b pair to compare.
db = db.getSiblingDB('foxdb');

db.customers.drop();
db.products.drop();
db.orders.drop();

db.customers.insertMany([
  { _id: 1, name: 'Alice Chen', email: 'alice@example.com', phone: '555-0101', tier: 'gold' },
  { _id: 2, name: 'Bob Patel', email: 'bob@example.com', phone: '555-0102', tier: 'standard' },
  { _id: 3, name: 'Cara Nguyen', email: 'cara@example.com', phone: null, tier: 'standard' },
]);

db.products.insertMany([
  { _id: 1, name: 'Notebook', sku: 'NB-100', price: 12.5, stock: 40, active: true },
  { _id: 2, name: 'Pen set', sku: 'PN-200', price: 4.0, stock: 120, active: true },
  { _id: 3, name: 'USB-C hub', sku: 'HB-300', price: 29.0, stock: 8, active: false },
]);

db.orders.insertMany([
  { _id: 1001, customer_id: 1, total: 41.5, status: 'shipped', items: [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 2 }] },
  { _id: 1002, customer_id: 2, total: 12.5, status: 'pending', items: [{ product_id: 1, qty: 1 }] },
]);

print('foxdb collections: ' + db.getCollectionNames().sort().join(', '));
print('customers ' + db.customers.countDocuments() + ', products ' + db.products.countDocuments() + ', orders ' + db.orders.countDocuments());
