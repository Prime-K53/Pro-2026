import { createServerDatabase } from '../src/server/db.ts';
import { AccountingError, ActorContext } from '../src/server/services/accountingEngine.ts';
import { createCustomer, createInvoiceOrSalesReceipt } from '../src/server/services/salesService.ts';

const cfg = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseServiceRoleKey: '',
  jwtSecret: 'test-secret',
  isProduction: false,
  nodeEnv: 'test',
};

async function main() {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });
  try {
    const users = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(
        `SELECT u.id, u.username, m.company_id
           FROM users u
           JOIN company_memberships m ON m.user_id = u.id
          WHERE u.is_active = TRUE
          ORDER BY u.id ASC`
      );
      return r.rows;
    });
    const admin = users.find((u: any) => String(u.username).toLowerCase() === 'admin') || users[0];
    const companyId = Number(admin.company_id);
    const actor: ActorContext = {
      userId: Number(admin.id),
      username: String(admin.username),
      role: 'Administrator',
    };

    // Create a customer
    const cust = await db.withCompanyDb(companyId, tx =>
      createCustomer(tx, companyId, actor, {
        name: 'Test Customer',
        companyName: 'Test Co',
        creditLimit: 10000,
      })
    );
    console.log('Customer created:', cust.customerCode, cust.customerStatus, cust.balance);

    // Get raw material item
    const rawMat = await db.withCompanyDb(companyId, async tx => {
      const rows = await tx.query(`SELECT id, name, item_type FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material' LIMIT 1`, [companyId]);
      return rows.rows[0] as { id: number; name: string; item_type: string };
    });
    console.log('Raw material item:', rawMat);

    // Try to create invoice with raw material
    try {
      await db.withCompanyDb(companyId, tx =>
        createInvoiceOrSalesReceipt(tx, companyId, actor, {
          customerId: cust.id,
          lines: [{ itemId: rawMat.id, description: 'Raw Paper Sale Attempt', quantity: 2, rate: 200, taxable: false }],
        })
      );
      console.log('ERROR: Should have thrown');
    } catch (err: any) {
      console.log('Expected error:', err.statusCode, err.code, err.message);
    }
  } finally {
    await db.close();
  }
}

main().catch(console.error);