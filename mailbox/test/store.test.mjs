import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS } from '../src/limits.mjs';
import { MailboxError, MailboxStore } from '../src/store.mjs';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

function open(limits = {}, path = ':memory:') {
  const clock = { now: 1_000_000 };
  const store = new MailboxStore(path, { ...DEFAULT_LIMITS, ...limits }, { now: () => clock.now });
  return { store, clock };
}

function withSender(store, key = KEY_A, sender = 'laifu', hash = `hash-${sender}`) {
  const { inbox } = store.register(key);
  store.putSender(inbox, sender, hash);
  return inbox;
}

function refused(fn, code, status) {
  assert.throws(fn, (error) => error instanceof MailboxError && error.code === code && error.status === status);
}

test('an envelope waits in its inbox, oldest first, until acknowledged', () => {
  const { store } = open();
  const inbox = withSender(store);
  const sent = ['one', 'two', 'three'].map((text) => store.put(inbox, 'laifu', Buffer.from(text)));

  const listed = store.list(inbox);
  assert.deepEqual(listed.map((envelope) => envelope.body.toString()), ['one', 'two', 'three']);
  assert.deepEqual(listed.map((envelope) => envelope.seq), sent.map((receipt) => receipt.seq));
  assert.ok(sent[0].seq < sent[1].seq && sent[1].seq < sent[2].seq);
  assert.equal(listed[0].sender, 'laifu');
  assert.equal(listed[0].received_at, 1_000_000);
  assert.equal(sent[0].expires_at, 1_000_000 + 604_800);

  assert.equal(store.ack(inbox, { through: sent[1].seq }), 2);
  assert.deepEqual(store.list(inbox).map((envelope) => envelope.body.toString()), ['three']);
  assert.deepEqual(store.inboxStatus(inbox), { pending: 1, pending_bytes: 5, senders: 1 });
  assert.equal(store.ack(inbox, { seqs: [sent[2].seq, sent[2].seq + 100] }), 1);
  assert.deepEqual(store.list(inbox), []);
});

test('each inbox numbers its own envelopes, from when it was made', () => {
  const { store } = open();
  const inboxA = withSender(store, KEY_A);
  const inboxB = withSender(store, KEY_B);

  const first = store.put(inboxA, 'laifu', Buffer.from('a1'));
  store.put(inboxB, 'laifu', Buffer.from('b1'));
  store.put(inboxB, 'laifu', Buffer.from('b2'));
  const second = store.put(inboxA, 'laifu', Buffer.from('a2'));

  assert.equal(first.seq, 1_000_000_001, 'a thousand a second from its creation time');
  assert.equal(second.seq, first.seq + 1, 'another inbox\'s envelopes leave no gap');
  assert.deepEqual(store.list(inboxB).map((envelope) => envelope.seq), [1_000_000_001, 1_000_000_002]);
});

test('an inbox made again under the same key numbers on past what its owner saw', () => {
  const { store, clock } = open();
  const inbox = withSender(store);
  const seen = [1, 2, 3].map(() => store.put(inbox, 'laifu', Buffer.from('x')).seq).at(-1);
  store.deleteInbox(inbox);

  clock.now += 1;
  withSender(store);
  assert.ok(store.put(inbox, 'laifu', Buffer.from('y')).seq > seen);
});

test('after and limit page through an inbox, and a page stops at its byte budget', () => {
  const { store } = open();
  const inbox = withSender(store);
  const seqs = [0, 1, 2, 3].map(() => store.put(inbox, 'laifu', Buffer.alloc(100)).seq);

  assert.deepEqual(store.list(inbox, { after: seqs[1] }).map((envelope) => envelope.seq), seqs.slice(2));
  assert.deepEqual(store.list(inbox, { limit: 2 }).map((envelope) => envelope.seq), seqs.slice(0, 2));
  assert.deepEqual(store.list(inbox, { maxBytes: 250 }).map((envelope) => envelope.seq), seqs.slice(0, 2));
  assert.deepEqual(store.list(inbox, { maxBytes: 50 }).map((envelope) => envelope.seq), seqs.slice(0, 1), 'always one');
});

test('an envelope at the size limit is kept and one byte more is refused', () => {
  const { store } = open({ maxEnvelopeBytes: 10 });
  const inbox = withSender(store);

  assert.ok(store.put(inbox, 'laifu', Buffer.alloc(10)).seq);
  refused(() => store.put(inbox, 'laifu', Buffer.alloc(11)), 'envelope_too_large', 413);
  refused(() => store.put(inbox, 'laifu', Buffer.alloc(0)), 'empty_envelope', 400);
});

test('a full inbox refuses more until it is drained', () => {
  const { store } = open({ maxPendingPerInbox: 2 });
  const inbox = withSender(store);
  const first = store.put(inbox, 'laifu', Buffer.from('a'));
  store.put(inbox, 'laifu', Buffer.from('b'));

  refused(() => store.put(inbox, 'laifu', Buffer.from('c')), 'inbox_full', 429);
  store.ack(inbox, { through: first.seq });
  assert.ok(store.put(inbox, 'laifu', Buffer.from('c')).seq);
});

test('an inbox also has a byte budget', () => {
  const { store } = open({ maxPendingBytesPerInbox: 10 });
  const inbox = withSender(store);
  store.put(inbox, 'laifu', Buffer.alloc(6));

  refused(() => store.put(inbox, 'laifu', Buffer.alloc(5)), 'inbox_full', 429);
  assert.ok(store.put(inbox, 'laifu', Buffer.alloc(4)).seq);
});

test('one sender can\'t fill an inbox for the others', () => {
  const { store } = open({ maxPendingPerSender: 1 });
  const inbox = withSender(store);
  store.putSender(inbox, 'mona', 'hash-mona');
  store.put(inbox, 'laifu', Buffer.from('a'));

  refused(() => store.put(inbox, 'laifu', Buffer.from('b')), 'sender_backlog', 429);
  assert.ok(store.put(inbox, 'mona', Buffer.from('c')).seq);
});

test('the mailbox refuses envelopes past its total storage', () => {
  const { store } = open({ maxTotalBytes: 15 });
  const inboxA = withSender(store, KEY_A);
  const inboxB = withSender(store, KEY_B);
  const first = store.put(inboxA, 'laifu', Buffer.alloc(10));

  refused(() => store.put(inboxB, 'laifu', Buffer.alloc(6)), 'mailbox_full', 507);
  store.ack(inboxA, { through: first.seq });
  assert.ok(store.put(inboxB, 'laifu', Buffer.alloc(6)).seq);
});

test('a repeated idempotency key returns the pending envelope instead of a copy', () => {
  const { store } = open();
  const inbox = withSender(store);
  store.putSender(inbox, 'mona', 'hash-mona');
  const first = store.put(inbox, 'laifu', Buffer.from('dispatch'), 'msg-1');

  assert.deepEqual(store.put(inbox, 'laifu', Buffer.from('dispatch'), 'msg-1'), { ...first, duplicate: true });
  assert.equal(first.duplicate, false);
  assert.notEqual(store.put(inbox, 'mona', Buffer.from('dispatch'), 'msg-1').seq, first.seq, 'another sender\'s key');
  assert.equal(store.list(inbox).length, 2);
  store.ack(inbox, { through: first.seq });
  assert.notEqual(store.put(inbox, 'laifu', Buffer.from('dispatch'), 'msg-1').seq, first.seq, 'once acknowledged, a new envelope');
});

test('an idempotency key whose envelope expired stores a new one in its place', () => {
  const { store, clock } = open({ ttlSeconds: 100, maxTotalBytes: 25 });
  const inboxA = withSender(store, KEY_A);
  const inboxB = withSender(store, KEY_B);
  const expired = store.put(inboxA, 'laifu', Buffer.alloc(10), 'msg-1');
  clock.now += 50;
  const kept = store.put(inboxB, 'laifu', Buffer.alloc(10));
  assert.equal(kept.seq, expired.seq, 'two inboxes made in the same second');

  clock.now += 50;
  // Room for it only once the expired envelope's bytes are given back.
  const again = store.put(inboxA, 'laifu', Buffer.alloc(10), 'msg-1');
  assert.equal(again.duplicate, false);
  assert.ok(again.seq > expired.seq);
  assert.deepEqual(store.list(inboxB).map((envelope) => envelope.seq), [kept.seq], 'the other inbox\'s envelope with that seq stays');
});

test('removing a sender drops what it left and stops its token', () => {
  const { store } = open();
  const inbox = withSender(store);
  store.put(inbox, 'laifu', Buffer.from('a'));
  store.put(inbox, 'laifu', Buffer.from('b'));

  assert.equal(store.senderFor(inbox, 'hash-laifu'), 'laifu');
  assert.equal(store.deleteSender(inbox, 'laifu'), true);
  assert.equal(store.deleteSender(inbox, 'laifu'), false);
  assert.equal(store.senderFor(inbox, 'hash-laifu'), undefined);
  assert.deepEqual(store.list(inbox), []);
  assert.deepEqual(store.inboxStatus(inbox), { pending: 0, pending_bytes: 0, senders: 0 });
});

test('a sender\'s token can be rotated but not shared with another sender', () => {
  const { store } = open();
  const inbox = withSender(store);
  store.put(inbox, 'laifu', Buffer.from('sent before the rotation'));
  store.putSender(inbox, 'laifu', 'hash-rotated');

  assert.equal(store.senderFor(inbox, 'hash-laifu'), undefined);
  assert.equal(store.senderFor(inbox, 'hash-rotated'), 'laifu');
  assert.deepEqual(store.list(inbox).map((envelope) => envelope.body.toString()), ['sent before the rotation']);
  refused(() => store.putSender(inbox, 'mona', 'hash-rotated'), 'token_in_use', 409);
});

test('an inbox holds a bounded number of senders', () => {
  const { store } = open({ maxSendersPerInbox: 2 });
  const inbox = withSender(store);
  store.putSender(inbox, 'mona', 'hash-mona');

  refused(() => store.putSender(inbox, 'friend', 'hash-friend'), 'too_many_senders', 409);
  store.putSender(inbox, 'mona', 'hash-mona-2');
  assert.equal(store.listSenders(inbox).length, 2);
});

test('senders are listed with what each has pending', () => {
  const { store, clock } = open();
  const inbox = withSender(store);
  store.putSender(inbox, 'mona', 'hash-mona');
  clock.now += 5;
  store.put(inbox, 'laifu', Buffer.from('a'));

  assert.deepEqual(store.listSenders(inbox), [
    { sender: 'laifu', pending: 1, last_sent_at: 1_000_005 },
    { sender: 'mona', pending: 0, last_sent_at: null },
  ]);
});

test('registering is idempotent and the mailbox holds a bounded number of inboxes', () => {
  const { store } = open({ maxInboxes: 1 });
  const first = store.register(KEY_A);

  assert.equal(first.created, true);
  assert.equal(first.inbox, 'cs1uhCLEB_ttCYaQ8RMLfe1-wvf14dML2dUh8BU2N5M');
  assert.deepEqual(store.register(KEY_A), { inbox: first.inbox, created: false });
  assert.deepEqual(store.inboxKey(first.inbox), KEY_A);
  refused(() => store.register(KEY_B), 'mailbox_full', 507);
});

test('expired envelopes stop showing and are pruned; idle inboxes are deleted', () => {
  const { store, clock } = open({ ttlSeconds: 100, inboxIdleDays: 1 });
  const inbox = withSender(store);
  store.put(inbox, 'laifu', Buffer.from('a'));

  clock.now += 99;
  assert.equal(store.list(inbox).length, 1);
  clock.now += 1;
  assert.equal(store.list(inbox).length, 0);
  assert.deepEqual(store.prune(), { envelopes: 1, inboxes: 0 });

  store.touch(inbox);
  clock.now += 86_399;
  assert.deepEqual(store.prune(), { envelopes: 0, inboxes: 0 });
  clock.now += 1;
  assert.deepEqual(store.prune(), { envelopes: 0, inboxes: 1 });
  assert.equal(store.inboxKey(inbox), undefined);
  assert.equal(store.senderFor(inbox, 'hash-laifu'), undefined);
});

test('pruning drops every idle inbox at once, with its senders and envelopes, and gives back their bytes', () => {
  const { store, clock } = open({ inboxIdleDays: 1, maxTotalBytes: 30 });
  const idle = [KEY_A, KEY_B, Buffer.alloc(32, 3)].map((key) => withSender(store, key));
  for (const inbox of idle) store.put(inbox, 'laifu', Buffer.alloc(10));

  clock.now += 86_400;
  const active = withSender(store, Buffer.alloc(32, 4));
  assert.deepEqual(store.prune(), { envelopes: 3, inboxes: 3 });
  for (const inbox of idle) {
    assert.equal(store.inboxKey(inbox), undefined);
    assert.equal(store.senderFor(inbox, 'hash-laifu'), undefined);
  }
  assert.ok(store.inboxKey(active));
  assert.ok(store.put(active, 'laifu', Buffer.alloc(30)).seq, 'their bytes were given back');
});

test('a full disk is reported as such, and the store keeps working', () => {
  const { store } = open();
  const inbox = withSender(store);
  // SQLite undoes the whole transaction itself when the file can't grow.
  store.db.exec(`PRAGMA max_page_count = ${store.db.prepare('PRAGMA page_count').get().page_count + 2}`);
  assert.throws(() => store.put(inbox, 'laifu', Buffer.alloc(200_000)), /database or disk is full/);

  store.db.exec('PRAGMA max_page_count = 1073741823');
  assert.ok(store.put(inbox, 'laifu', Buffer.from('fits')).seq);
});

test('deleting an inbox removes its senders and envelopes', () => {
  const { store } = open({ maxTotalBytes: 10 });
  const inbox = withSender(store);
  store.put(inbox, 'laifu', Buffer.alloc(10));

  assert.equal(store.deleteInbox(inbox), true);
  assert.equal(store.deleteInbox(inbox), false);
  assert.equal(store.senderFor(inbox, 'hash-laifu'), undefined);
  const again = withSender(store);
  assert.ok(store.put(again, 'laifu', Buffer.alloc(10)).seq, 'its bytes were given back');
});

test('envelopes, senders and the storage total survive a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-store-'));
  try {
    const path = join(directory, 'mailbox.sqlite');
    const first = open({ maxTotalBytes: 10 }, path);
    const inbox = withSender(first.store);
    const sent = first.store.put(inbox, 'laifu', Buffer.from('kept'));
    first.store.close();

    const second = open({ maxTotalBytes: 10 }, path);
    assert.equal(second.store.senderFor(inbox, 'hash-laifu'), 'laifu');
    assert.deepEqual(second.store.list(inbox).map((envelope) => [envelope.seq, envelope.body.toString()]), [[sent.seq, 'kept']]);
    refused(() => second.store.put(inbox, 'laifu', Buffer.alloc(7)), 'mailbox_full', 507);
    assert.ok(second.store.put(inbox, 'laifu', Buffer.alloc(6)).seq > sent.seq);
    second.store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a database from an earlier or later mailbox is refused, saying what to do', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-store-'));
  try {
    const first = join(directory, 'first-release.sqlite');
    const old = new DatabaseSync(first);
    // The first release's tables, which numbered envelopes across the whole mailbox.
    old.exec(`CREATE TABLE inboxes (id TEXT PRIMARY KEY, key BLOB NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE TABLE envelopes (seq INTEGER PRIMARY KEY AUTOINCREMENT, inbox TEXT NOT NULL)`);
    old.close();
    assert.throws(() => open({}, first), /numbered envelopes across the whole mailbox.*move it aside/s);

    const later = join(directory, 'later.sqlite');
    open({}, later).store.close();
    const newer = new DatabaseSync(later);
    newer.exec('PRAGMA user_version = 99');
    newer.close();
    assert.throws(() => open({}, later), /newer mailbox/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
