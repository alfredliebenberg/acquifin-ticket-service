require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const cron       = require('node-cron');
const Imap       = require('imap');
const { simpleParser } = require('mailparser');
const { createClient }  = require('@supabase/supabase-js');

const app  = express();
const port = process.env.PORT || 3000;

// ── Supabase ────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // use service role key (not anon) so we bypass RLS
);

// ── Multer — memory storage for attachments (max 20 MB total) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ── SMTP transporter (Axxess / cPanel) ─────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,          // cphost28.vpslocal.co.za
  port: parseInt(process.env.MAIL_SMTP_PORT || '465'),
  secure: true,                          // SSL on 465
  auth: {
    user: process.env.MAIL_USER,         // tickets@acquifinholdings.co.za
    pass: process.env.MAIL_PASS
  },
  tls: { rejectUnauthorized: false }     // cPanel self-signed cert
});

// ── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '25mb' }));

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Acquifin Ticket Service running', time: new Date().toISOString() });
});

// ────────────────────────────────────────────────────────────
// POST /ticket  — create ticket, store in Supabase, send email
// ────────────────────────────────────────────────────────────
app.post('/ticket', upload.array('attachments', 5), async (req, res) => {
  try {
    const {
      id, topic, priority, description,
      systems, cc, name, email, createdAt
    } = req.body;

    const ccList   = cc ? (typeof cc === 'string' ? JSON.parse(cc) : cc) : [];
    const sysList  = systems ? (typeof systems === 'string' ? JSON.parse(systems) : systems) : [];
    const files    = req.files || [];

    // ── 1. Store in Supabase ──────────────────────────────
    const attachmentMeta = files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype }));

    const { error: dbErr } = await supabase
      .from('ticket_mail')
      .insert({
        ticket_id:    id,
        topic,
        priority,
        description,
        systems:      sysList,
        cc:           ccList,
        staff_name:   name,
        staff_email:  email,
        created_at:   createdAt || new Date().toISOString(),
        status:       'open',
        closed_at:    null,
        attachments:  attachmentMeta,
        timeline:     [{ ts: new Date().toISOString(), msg: `Ticket created by ${name}` }]
      });

    if (dbErr) {
      console.error('Supabase insert error:', dbErr);
      return res.status(500).json({ error: 'Database error', detail: dbErr.message });
    }

    // ── 2. Build and send email ───────────────────────────
    const prioLabels = {
      critical: 'Critical — Affects all staff',
      serious:  'Serious — Staff member unable to work',
      medium:   'Medium — Impacts production',
      medlow:   'Medium-Low — Within 48 hours',
      low:      'Low — No direct production impact'
    };

    const sysLine  = sysList.length  ? `\nSystems to deactivate : ${sysList.join(', ')}` : '';
    const ccLine   = ccList.length   ? `\nCC                    : ${ccList.join(', ')}` : '';

    const bodyText =
`ACQUIFIN HOLDINGS — SUPPORT TICKET
═══════════════════════════════════════
Ticket Number         : ${id}
Topic                 : ${topic}
Priority              : ${prioLabels[priority] || priority}
From                  : ${name} <${email}>${ccLine}
Date/Time             : ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}${sysLine}
═══════════════════════════════════════

DESCRIPTION:
${description}

${files.length ? `ATTACHMENTS: ${files.map(f => f.originalname).join(', ')}` : ''}

───────────────────────────────────────
To CLOSE this ticket, reply to this email.
Your reply will automatically mark the ticket as resolved.

Ticket reference: ${id}
───────────────────────────────────────`;

    const mailOptions = {
      from:    `"Acquifin Tickets" <${process.env.MAIL_USER}>`,
      to:      process.env.TICKET_TO_EMAIL,   // systems@bridge.co.za
      cc:      ccList.length ? ccList.join(', ') : undefined,
      replyTo: process.env.MAIL_USER,          // replies come back to tickets@acquifinholdings.co.za
      subject: `[${id}] ${topic} — ${prioLabels[priority] || priority}`,
      text:    bodyText,
      // Keep ticket ID in headers so IMAP polling can match replies
      headers: { 'X-Ticket-ID': id }
    };

    // Attach files
    if (files.length) {
      mailOptions.attachments = files.map(f => ({
        filename:    f.originalname,
        content:     f.buffer,
        contentType: f.mimetype
      }));
    }

    await transporter.sendMail(mailOptions);
    console.log(`Ticket ${id} sent to ${process.env.TICKET_TO_EMAIL}`);

    res.json({ success: true, ticket_id: id });

  } catch (err) {
    console.error('Ticket creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /tickets  — fetch tickets for the HTML frontend
// ────────────────────────────────────────────────────────────
app.get('/tickets', async (req, res) => {
  try {
    const email = req.query.email;
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

// ────────────────────────────────────────────────────────────
// POST /close/:id  — manually close a ticket (admin)
// ────────────────────────────────────────────────────────────
app.post('/close/:id', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const now = new Date().toISOString();

    // Fetch existing ticket to append to timeline
    const { data: existing } = await supabase
      .from('ticket_mail').select('timeline, created_at').eq('ticket_id', ticketId).single();

    const timeline = existing?.timeline || [];
    const created  = existing?.created_at;
    const duration = created ? formatDuration(new Date(now) - new Date(created)) : '—';

    timeline.push({ ts: now, msg: `Ticket closed manually — resolved in ${duration}` });

    const { error } = await supabase
      .from('ticket_mail')
      .update({ status: 'closed', closed_at: now, timeline })
      .eq('ticket_id', ticketId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// IMAP Polling — check for replies every 3 minutes
// ────────────────────────────────────────────────────────────
function pollInbox() {
  console.log('Polling inbox for ticket replies...');

  const imap = new Imap({
    user:     process.env.MAIL_USER,
    password: process.env.MAIL_PASS,
    host:     process.env.MAIL_HOST,
    port:     parseInt(process.env.MAIL_IMAP_PORT || '993'),
    tls:      true,
    tlsOptions: { rejectUnauthorized: false }
  });

  imap.once('error', err => {
    console.error('IMAP error:', err.message);
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) { imap.end(); return; }

      // Search for unread messages
      imap.search(['UNSEEN'], async (err, results) => {
        if (err || !results || results.length === 0) {
          imap.end();
          return;
        }

        console.log(`Found ${results.length} unread message(s)`);
        const fetch = imap.fetch(results, { bodies: '' });
        const processed = [];

        fetch.on('message', (msg, seqno) => {
          let buffer = '';
          msg.on('body', stream => {
            stream.on('data', chunk => buffer += chunk.toString('utf8'));
          });

          msg.once('attributes', attrs => {
            msg._uid = attrs.uid;
          });

          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(buffer);
              const subject = parsed.subject || '';
              const from    = parsed.from?.text || '';
              const text    = parsed.text || '';

              // Extract ticket ID from subject line e.g. [TKT-2506-1234]
              const match = subject.match(/\[?(TKT-\d{4}-\d{4})\]?/i);
              if (!match) return;

              const ticketId = match[1];
              console.log(`Reply detected for ticket ${ticketId} from ${from}`);

              // Fetch ticket from Supabase
              const { data: ticket } = await supabase
                .from('ticket_mail')
                .select('*')
                .eq('ticket_id', ticketId)
                .single();

              if (!ticket || ticket.status === 'closed') return;

              const now      = new Date().toISOString();
              const duration = formatDuration(new Date(now) - new Date(ticket.created_at));
              const timeline = ticket.timeline || [];

              timeline.push({
                ts:  now,
                msg: `Reply received from ${from} — ticket automatically closed. Resolved in ${duration}.`,
                reply_excerpt: text.substring(0, 300)
              });

              await supabase
                .from('ticket_mail')
                .update({ status: 'closed', closed_at: now, timeline })
                .eq('ticket_id', ticketId);

              console.log(`Ticket ${ticketId} auto-closed. Duration: ${duration}`);
              processed.push(msg._uid);

            } catch (e) {
              console.error('Parse error:', e.message);
            }
          });
        });

        fetch.once('end', () => {
          // Mark processed messages as seen
          if (processed.length) {
            imap.setFlags(processed, ['\\Seen'], err => {
              if (err) console.error('Flag error:', err);
            });
          }
          imap.end();
        });
      });
    });
  });

  imap.connect();
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Run poll every 3 minutes
cron.schedule('*/3 * * * *', pollInbox);

// ── Start server ─────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Acquifin Ticket Service running on port ${port}`);
  // Initial poll on startup
  setTimeout(pollInbox, 5000);
});
