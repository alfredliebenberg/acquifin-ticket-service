require('dotenv').config();
const express        = require('express');
const nodemailer     = require('nodemailer');
const cron           = require('node-cron');
const Imap           = require('imap');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const port = process.env.PORT || 3000;

// ── Supabase (service role) ──────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Gmail SMTP transporter ───────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,   // acquifin.tickets@gmail.com
    pass: process.env.MAIL_PASS    // 16-char app password
  }
});

// ── Middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '5mb' }));

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Acquifin Ticket Service running', time: new Date().toISOString() });
});

// ── One-click close link ─────────────────────────────────────
app.get('/close-link/:id', async (req, res) => {
  const ticketId = req.params.id;
  try {
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from('ticket_mail').select('timeline,created_at,status').eq('ticket_id', ticketId).single();

    if (!existing) return res.send('<h2>Ticket not found: ' + ticketId + '</h2>');

    if (existing.status === 'closed') {
      return res.send('<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center">' +
        '<h2>✅ Already Closed</h2><p>Ticket <strong>' + ticketId + '</strong> was already closed.</p></body></html>');
    }

    const timeline = existing.timeline || [];
    const duration = existing.created_at ? formatDuration(new Date(now) - new Date(existing.created_at)) : '—';
    timeline.push({ ts: now, msg: 'Ticket closed via email link — resolved in ' + duration });

    await supabase.from('ticket_mail')
      .update({ status: 'closed', closed_at: now, timeline })
      .eq('ticket_id', ticketId);

    console.log('Ticket ' + ticketId + ' closed via link. Duration: ' + duration);

    res.send('<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center;padding:20px">' +
      '<div style="font-size:60px">✅</div>' +
      '<h2 style="color:#0B1F3A">Ticket Closed</h2>' +
      '<p><strong>' + ticketId + '</strong> has been marked as resolved.</p>' +
      '<p style="color:#666;font-size:14px">Resolved in ' + duration + '</p>' +
      '<p style="color:#888;font-size:12px;margin-top:30px">Acquifin Holdings — Ticket System</p>' +
      '</body></html>');
  } catch (err) {
    console.error('Close-link error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Manual close (admin button) ──────────────────────────────
app.post('/close/:id', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from('ticket_mail').select('timeline,created_at').eq('ticket_id', ticketId).single();
    const timeline = existing?.timeline || [];
    const duration = existing?.created_at ? formatDuration(new Date(now) - new Date(existing.created_at)) : '—';
    timeline.push({ ts: now, msg: 'Ticket closed manually — resolved in ' + duration });
    await supabase.from('ticket_mail')
      .update({ status: 'closed', closed_at: now, timeline })
      .eq('ticket_id', ticketId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET tickets (frontend sync) ──────────────────────────────
app.get('/tickets', async (req, res) => {
  try {
    const email   = req.query.email;
    const isAdmin = req.query.admin === '1';
    let query = supabase.from('ticket_mail').select('*').order('created_at', { ascending: false });
    if (!isAdmin && email) query = query.eq('staff_email', email);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POLL SUPABASE — send emails for new tickets (every 30 seconds)
// ═══════════════════════════════════════════════════════════════
async function processNewTickets() {
  try {
    const { data: tickets, error } = await supabase
      .from('ticket_mail')
      .select('*')
      .eq('email_sent', false)
      .order('created_at', { ascending: true });

    if (error) { console.error('Supabase poll error:', error.message); return; }
    if (!tickets || tickets.length === 0) return;

    console.log('Found ' + tickets.length + ' unsent ticket(s)');
    for (const ticket of tickets) {
      await sendTicketEmail(ticket);
    }
  } catch (err) {
    console.error('processNewTickets error:', err.message);
  }
}

async function sendTicketEmail(ticket) {
  const prioLabels = {
    critical: 'Critical — Affects all staff',
    serious:  'Serious — Staff member unable to work',
    medium:   'Medium — Impacts production',
    medlow:   'Medium-Low — Within 48 hours',
    low:      'Low — No direct production impact'
  };

  const prioLabel  = prioLabels[ticket.priority] || ticket.priority;
  const ccList     = Array.isArray(ticket.cc)      ? ticket.cc      : [];
  const sysList    = Array.isArray(ticket.systems) ? ticket.systems : [];
  const sysLine    = sysList.length ? '\nSystems to deactivate : ' + sysList.join(', ') : '';
  const ccLine     = ccList.length  ? '\nCC                    : ' + ccList.join(', ')  : '';
  const closeLink  = 'https://fortunate-flow-production-d5e8.up.railway.app/close-link/' + ticket.ticket_id;

  const bodyText =
`ACQUIFIN HOLDINGS — SUPPORT TICKET
═══════════════════════════════════════
Ticket Number         : ${ticket.ticket_id}
Topic                 : ${ticket.topic}
Priority              : ${prioLabel}
From                  : ${ticket.staff_name} <${ticket.staff_email}>${ccLine}
Date/Time             : ${new Date(ticket.created_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}${sysLine}
═══════════════════════════════════════

DESCRIPTION:
${ticket.description}

───────────────────────────────────────
CLOSE THIS TICKET:
${closeLink}

Click the link above once resolved.
The ticket will be marked as closed automatically.

Ticket reference: ${ticket.ticket_id}
───────────────────────────────────────`;

  const mailOptions = {
    from:    '"Acquifin Tickets" <' + process.env.MAIL_USER + '>',
    to:      process.env.TICKET_TO_EMAIL,
    cc:      ccList.length ? ccList.join(', ') : undefined,
    replyTo: process.env.MAIL_USER,
    subject: '[' + ticket.ticket_id + '] ' + ticket.topic + ' — ' + prioLabel,
    text:    bodyText
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('✅ Email sent: ' + ticket.ticket_id + ' → ' + process.env.TICKET_TO_EMAIL);

    const timeline = ticket.timeline || [];
    timeline.push({ ts: new Date().toISOString(), msg: 'Email sent to ' + process.env.TICKET_TO_EMAIL });
    await supabase.from('ticket_mail')
      .update({ email_sent: true, timeline })
      .eq('ticket_id', ticket.ticket_id);

  } catch (err) {
    console.error('❌ Email failed for ' + ticket.ticket_id + ':', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// IMAP — poll Gmail inbox for replies (every 3 minutes)
// ═══════════════════════════════════════════════════════════════
function pollInbox() {
  const imap = new Imap({
    user:       process.env.MAIL_USER,
    password:   process.env.MAIL_PASS,
    host:       'imap.gmail.com',
    port:       993,
    tls:        true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 10000,
    authTimeout: 10000
  });

  imap.once('error', err => console.error('IMAP error:', err.message));

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err) => {
      if (err) { imap.end(); return; }
      imap.search(['UNSEEN'], async (err, results) => {
        if (err || !results || results.length === 0) { imap.end(); return; }
        console.log('📬 ' + results.length + ' unread message(s)');

        const fetch = imap.fetch(results, { bodies: '' });
        const seen  = [];

        fetch.on('message', (msg) => {
          let buffer = '';
          let uid;
          msg.on('body', stream => { stream.on('data', c => buffer += c.toString('utf8')); });
          msg.once('attributes', attrs => { uid = attrs.uid; });
          msg.once('end', async () => {
            try {
              const parsed  = await simpleParser(buffer);
              const subject = parsed.subject || '';
              const from    = parsed.from?.text || '';
              const match   = subject.match(/\[?(TKT-\d{4}-\d{4})\]?/i);
              if (!match) return;

              const ticketId = match[1];
              console.log('Reply for ' + ticketId + ' from ' + from);

              const { data: ticket } = await supabase
                .from('ticket_mail').select('*').eq('ticket_id', ticketId).single();
              if (!ticket || ticket.status === 'closed') return;

              const now      = new Date().toISOString();
              const duration = formatDuration(new Date(now) - new Date(ticket.created_at));
              const timeline = ticket.timeline || [];
              timeline.push({ ts: now, msg: 'Reply from ' + from + ' — auto-closed. Resolved in ' + duration });

              await supabase.from('ticket_mail')
                .update({ status: 'closed', closed_at: now, timeline })
                .eq('ticket_id', ticketId);

              console.log('✅ Ticket ' + ticketId + ' auto-closed. Duration: ' + duration);
              if (uid) seen.push(uid);
            } catch (e) {
              console.error('Parse error:', e.message);
            }
          });
        });

        fetch.once('end', () => {
          if (seen.length) imap.setFlags(seen, ['\\Seen'], () => {});
          imap.end();
        });
      });
    });
  });

  imap.connect();
}

function formatDuration(ms) {
  const m = Math.floor(Math.abs(ms) / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// ── Schedules ─────────────────────────────────────────────────
cron.schedule('*/30 * * * * *', processNewTickets);  // every 30 seconds
cron.schedule('*/3 * * * *',    pollInbox);           // every 3 minutes

// ── Start ─────────────────────────────────────────────────────
app.listen(port, () => {
  console.log('🚀 Acquifin Ticket Service running on port ' + port);
  setTimeout(processNewTickets, 3000);
  setTimeout(pollInbox, 8000);
});
