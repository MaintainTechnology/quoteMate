// Live watch — polls Supabase every 2s and shows the pipeline progress for
// the most recent calls. Run this in a second terminal, then place a real
// Vapi call. Watch the row appear and progress through call → intake → quote.
//
//   node --env-file=.env.local scripts/watch-chain.mjs
//
// Ctrl+C to exit.

import pg from "pg";
const { Client } = pg;

const POLL_MS = 2000;
const SHOW_LAST_N = 8;

const c = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function fmtAge(ts) {
  if (!ts) return "—";
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : "—";
}

async function snapshot() {
  const { rows } = await c.query(
    `select
       c.id              as call_id,
       c.vapi_call_id,
       c.caller_number,
       c.ended_at,
       length(c.transcript) as transcript_len,
       i.id              as intake_id,
       i.job_type,
       i.confidence,
       i.inspection_required,
       q.id              as quote_id,
       q.status          as quote_status,
       q.selected_tier,
       q.total_inc_gst
     from calls c
     left join intakes i on i.call_id = c.id
     left join quotes  q on q.intake_id = i.id
     order by c.ended_at desc nulls last
     limit $1`,
    [SHOW_LAST_N]
  );
  return rows;
}

function render(rows) {
  clearScreen();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n  QuoteMate · pipeline watch  ·  ${now}  ·  polling every ${POLL_MS}ms  ·  Ctrl+C to exit\n`);

  if (rows.length === 0) {
    console.log("  (no calls yet — place a call to +61 7 4518 0330)\n");
    return;
  }

  const header = "  vapi_call_id".padEnd(40) +
    " age".padEnd(14) +
    " call".padEnd(7) +
    " intake".padEnd(28) +
    " quote".padEnd(30);
  console.log(header);
  console.log("  " + "─".repeat(header.length - 2));

  for (const r of rows) {
    const id = (r.vapi_call_id ?? "—").slice(0, 36).padEnd(38);
    const age = fmtAge(r.ended_at).padEnd(13);

    const callMark = r.call_id ? "✓" : "·";

    let intakeCell;
    if (r.intake_id) {
      const flag = r.inspection_required ? " 🔍insp" : "";
      intakeCell = `✓ ${r.job_type ?? "?"}/${r.confidence ?? "?"}${flag}`;
    } else if (r.transcript_len) {
      intakeCell = "⏳ structuring…";
    } else {
      intakeCell = "·";
    }
    intakeCell = intakeCell.padEnd(27);

    let quoteCell;
    if (r.quote_id) {
      const tier = r.selected_tier ?? "?";
      const total = r.total_inc_gst != null ? `$${Number(r.total_inc_gst).toFixed(2)}` : "$?";
      quoteCell = `✓ ${tier} ${total} (${r.quote_status})`;
    } else if (r.intake_id && !r.inspection_required) {
      quoteCell = "⏳ Opus drafting…";
    } else if (r.intake_id && r.inspection_required) {
      quoteCell = "↪ inspection route";
    } else {
      quoteCell = "·";
    }
    quoteCell = quoteCell.padEnd(29);

    console.log(`  ${id} ${age} ${callMark.padEnd(6)} ${intakeCell} ${quoteCell}`);
  }
  console.log("");
}

let running = true;
process.on("SIGINT", () => {
  running = false;
  clearScreen();
  console.log("\n  Stopped.\n");
  c.end().then(() => process.exit(0));
});

while (running) {
  try {
    const rows = await snapshot();
    render(rows);
  } catch (e) {
    console.error("query error:", e.message);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
