const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createStockDb, user, other, stranger, household, otherHousehold } = require('./helpers/stock-db.cjs');

test('account erasure requires a new password session, preserves family undo and leaves only an expiring receipt', async () => {
  const { db, rpc, add, cart } = await createStockDb();
  try {
    const code = randomUUID();
    const fresh = randomUUID();
    const legacy = randomUUID();
    const owned = randomUUID();
    const otherOwned = randomUUID();
    const row = (sql, args) => db.query(sql, args).then(r => r.rows[0]);
    function request(action, receipt, actor = user, sid = actor, amr = [], role = actor ? 'authenticated' : 'anon') {
      return db.transaction(async tx => {
        await tx.exec('set local role ' + role);
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, session_id: sid, amr })]);
        return (await tx.query('select public.sf_account_erasure($1, $2) as data', [action, receipt])).rows[0].data;
      });
    }
    const lot = await add();
    const purchase = await cart();
    const useId = randomUUID();
    await rpc('used', { id: lot, expected_qty: 500, expected_unit: 'г', amount: 10 }, { id: useId, as: other });
    await db.query(`insert into family_profiles(id, household_id, created_by, profile_owner_user_id, name, age)
      values ($1,$2,$3,null,'Unassigned legacy',40), ($4,null,$3,$3,'Own profile',30), ($5,null,$6,$6,'Other profile',32)`,
      [legacy, household, user, owned, otherOwned, other]);
    await db.query("insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-01',70),($2,'2026-11-01',71)", [legacy, owned]);
    await db.query("insert into dietitian_messages(user_id,role,content) values($1,'user','Owned synthetic archive'),($2,'user','Other synthetic archive')", [user, other]);
    await db.query("insert into auth.flow_state(id,user_id) values(gen_random_uuid(),$1)", [user]);
    await db.query(`insert into sf_private.stock_release_backup(source_table,source_id,row_data)
      select 'fridge_items',id::text,to_jsonb(f) from fridge_items f where id = $1`, [lot]);
    assert.deepEqual(await request('availability', null), { enabled: false });
    await assert.rejects(request('prepare', code), { code: '55000' });
    await db.query('update sf_private.account_erasure_control set acceptance_actor=$1, acceptance_until=now()+interval \'1 minute\'', [user]);
    assert.deepEqual(await request('availability', null, other), { enabled: false });
    await assert.rejects(request('prepare', code, null), { code: '42501' });
    assert.deepEqual(await request('prepare', code), { status: 'confirmation_required' });
    assert.deepEqual(await request('status', code, null), { status: 'unknown_or_expired' });
    await assert.rejects(request('delete', code), { code: '42501' });
    await db.exec('update sf_private.account_erasure_control set enabled = true');
    await assert.rejects(request('delete', code, other), { code: '22023' });
    const password = [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) + 1 }];
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [fresh, user]);
    await assert.rejects(request('delete', code, user, fresh, [{ method: 'otp', timestamp: password[0].timestamp }]), { code: '42501' });
    await db.query("insert into auth.mfa_factors values(gen_random_uuid(),$1,'verified')", [user]);
    await assert.rejects(request('delete', code, user, fresh, password), { code: '42501' });
    await db.query('delete from auth.mfa_factors where user_id = $1', [user]);

    // Fail a dependent write after receipt update and verify both sides roll back.
    await db.exec(`create function public.reject_test_delete() returns trigger language plpgsql as
      $$begin raise exception 'injected failure'; end$$;
      create trigger reject_test_delete before delete on auth.users for each row execute function public.reject_test_delete()`);
    await assert.rejects(request('delete', code, user, fresh, password), /injected failure/);
    assert.deepEqual(await request('status', code, null), { status: 'unknown_or_expired' });
    assert.equal((await row('select user_id from fridge_items where id = $1', [lot])).user_id, user);
    await db.exec('drop trigger reject_test_delete on auth.users; drop function public.reject_test_delete()');

    const result = await request('delete', code, user, fresh, password);
    assert.equal(result.status, 'active_account_deleted');
    assert.equal(Date.parse(result.expires_at) - Date.parse(result.completed_at), 90 * 86400 * 1000);
    assert.deepEqual(await request('status', code, null), result);
    await assert.rejects(request('delete', code, user, fresh, password), { code: '42501' });
    for (const sql of [
      'select id from auth.users where id=$1', 'select id from auth.sessions where user_id=$1',
      'select id from auth.flow_state where user_id=$1', 'select id from dietitian_messages where user_id=$1',
      'select user_id from household_members where user_id=$1', 'select id from family_profiles where profile_owner_user_id=$1',
      'select source_id from sf_private.stock_release_backup where row_data->>\'user_id\'=$1::text',
    ]) assert.equal(await row(sql, [user]), undefined, sql);
    assert.equal((await row('select user_id from cart_items where id = $1', [purchase])).user_id, null);
    assert.notEqual((await row('select invite_code from households where id=$1', [household])).invite_code, 'FIRST1');
    const legacyRow = await row('select created_by,profile_owner_user_id,household_id,name from family_profiles where id=$1', [legacy]);
    assert.deepEqual(legacyRow, { created_by: null, profile_owner_user_id: null, household_id: household, name: 'Unassigned legacy' });
    assert.ok(await row('select id from family_measurements where profile_id=$1', [legacy]));
    assert.equal(await row('select id from family_measurements where profile_id=$1', [owned]), undefined);
    assert.ok(await row('select id from family_profiles where id=$1', [otherOwned]));
    assert.ok(await row('select id from dietitian_messages where user_id=$1', [other]));
    await rpc('undo', { operation_id: useId }, { as: other });
    const shared = await row('select user_id, qty_num from fridge_items where id = $1', [lot]);
    assert.equal(shared.user_id, null);
    assert.equal(Number(shared.qty_num), 500);
    await assert.rejects(rpc('used', { id: lot, expected_qty: 500, expected_unit: 'г', amount: 1 }), { code: '42501' });
    const receiptRow = await row('select actor, original_session, encode(receipt_hash,\'hex\') as hash from sf_private.account_erasure_receipts');
    assert.equal(receiptRow.actor, null);
    assert.equal(receiptRow.original_session, null);
    assert.notEqual(receiptRow.hash, code);

    await db.exec("update sf_private.account_erasure_receipts set expires_at=now()-interval '1 second'");
    assert.deepEqual(await request('status', code, null), { status: 'unknown_or_expired' });
    await db.exec('select sf_private.purge_expired_deletion_receipts()');
    assert.deepEqual(await request('status', code, null), { status: 'unknown_or_expired' });
    await assert.rejects(request('delete', code, other), { code: '22023' });
    assert.ok(await row('select id from auth.users where id=$1', [other]));
  } finally { await db.close(); }
});

test('restore reconciliation can remove the sole member without reopening a closed old profile', async () => {
  const { db, rpc } = await createStockDb();
  let restored;
  try {
    const legacy = randomUUID();
    const item = randomUUID();
    await db.query("insert into family_profiles(id,household_id,created_by,name,age) values($1,$2,$3,'Unassigned',30)", [legacy, otherHousehold, stranger]);
    await rpc('add_item', { name: 'Solo stock', qty_num: 1, unit: 'шт', compartment: 'fridge', location: 'Полка' },
      { as: stranger, hh: otherHousehold, id: item });
    const backup = await db.dumpDataDir('gzip');
    restored = await PGlite.create({ loadDataDir: backup });
    assert.equal((await restored.query('select id from auth.users where id=$1', [stranger])).rowCount, 1);
    const first = await restored.query('select sf_private.erase_account($1) as deleted', [stranger]);
    const again = await restored.query('select sf_private.erase_account($1) as deleted', [stranger]);
    assert.equal(first.rows[0].deleted, true);
    assert.equal(again.rows[0].deleted, false);
    assert.equal((await restored.query('select id from fridge_items where id=$1', [item])).rowCount, 0);
    const closed = (await restored.query('select h.invite_code, p.profile_owner_user_id from households h join family_profiles p on h.id=p.household_id where p.id=$1', [legacy])).rows[0];
    assert.equal(closed.profile_owner_user_id, null);
    await restored.transaction(async tx => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [other]);
      assert.equal((await tx.query('select public.join_household($1) as joined', [closed.invite_code])).rows[0].joined, null);
      assert.equal((await tx.query('select id from family_profiles where id=$1', [legacy])).rowCount, 0);
    });
  } finally { await restored?.close(); await db.close(); }
});
