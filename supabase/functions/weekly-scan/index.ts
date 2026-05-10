// ============================================================
// Edge Function: weekly-scan
// Runs decay + coherence scans, sends Resend weekly digest
// Schedule: every Monday 09:00 Singapore time (01:00 UTC)
// Deploy name: weekly-scan
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const appInboxUrl = 'https://ncheewee.github.io/second-brain-manager/?tab=inbox'

type DigestEntry = {
  title?: string
  body?: string
  space?: string
  layer?: string
  perishability?: string
  tags?: string[]
  updated_at?: string
  created_by_tool?: string
  status?: string
}

type InboxItem = {
  type?: string
  title?: string
  deadline?: string
  space?: string
}

type DigestCard = {
  kicker: string
  title: string
  body: string
}

type ReflectionDigest = {
  headline: string
  subhead: string
  opener: string
  cards: DigestCard[]
  questions: string[]
  footer_note: string
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clampText(value: unknown, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text
}

function countBy(values: string[]) {
  return values.reduce((acc, value) => {
    if (!value) return acc
    acc[value] = (acc[value] || 0) + 1
    return acc
  }, {} as Record<string, number>)
}

function topItems(counts: Record<string, number>, limit = 4) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
}

function niceList(items: string[]) {
  if (!items.length) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function labelize(value: string) {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function buildDeterministicDigest(entries: DigestEntry[], inboxItems: InboxItem[]): ReflectionDigest {
  if (!entries.length) {
    return {
      headline: 'A quiet week in the second brain',
      subhead: 'No major new memory movement was captured in the last 7 days.',
      opener: 'Quiet is still information. It may mean the system is stable, or simply that fewer second-brain-worthy decisions were captured.',
      cards: [
        {
          kicker: 'Signal',
          title: 'Nothing urgent is trying to reorganize the picture',
          body: 'There were no active memory updates this week, so the useful check is whether that reflects genuine steadiness or a gap in capture.',
        },
      ],
      questions: [
        'Was this week actually quiet, or did the important thinking happen outside the system?',
        'Is there one decision, preference, or recurring pattern worth saving before it fades?',
      ],
      footer_note: inboxItems.length ? 'There are still inbox items waiting for review.' : 'Your review inbox is clear.',
    }
  }

  const spaces = topItems(countBy(entries.map(e => e.space || 'unknown')))
  const layers = topItems(countBy(entries.map(e => e.layer || 'unknown')))
  const tags = topItems(countBy(entries.flatMap(e => e.tags || [])), 6)
  const topSpaceNames = spaces.map(([name]) => labelize(name))
  const topLayerNames = layers.map(([name]) => labelize(name))
  const topTagNames = tags.map(([name]) => labelize(name))
  const recentTitles = entries.slice(0, 4).map(e => e.title || 'Untitled memory')
  const financeOrTransport = topTagNames.some(tag =>
    ['finance', 'cost of living', 'transport', 'motorcycle', 'ev', 'car ownership', 'singapore'].includes(tag)
  )
  const buildOrWorkflow = topTagNames.some(tag =>
    ['ai agents', 'vibe coding', 'development methodology', 'prototyping', 'github pages'].includes(tag)
  )

  const primaryTheme = topTagNames.length
    ? niceList(topTagNames.slice(0, 3))
    : niceList(topSpaceNames)
  const headline = primaryTheme
    ? `This week is clustering around ${primaryTheme}`
    : 'This week has a few useful signals'
  const subhead = `${entries.length} recent memor${entries.length === 1 ? 'y' : 'ies'} across ${niceList(topSpaceNames)}.`

  const cards: DigestCard[] = [
    {
      kicker: 'Current Shape',
      title: 'The system is showing where attention is settling',
      body: `Most updates sit in ${niceList(topSpaceNames)} and lean toward ${niceList(topLayerNames)} memory. The useful signal is not the count, but the repeated pull toward ${primaryTheme || 'the same few concerns'}.`,
    },
    {
      kicker: 'Pattern',
      title: financeOrTransport
        ? 'You are comparing choices through optionality and total cost'
        : buildOrWorkflow
          ? 'You are turning fuzzy workflows into reusable operating models'
          : 'The recent notes are becoming a map of decision style',
      body: financeOrTransport
        ? 'The captures read less like shopping notes and more like a practical model for trade-offs: cash flow, convenience, resilience, and what stays useful over time.'
        : buildOrWorkflow
          ? 'The through-line is increasingly about making AI development repeatable: clear defaults, local keys, visible UAT, and versioned handovers.'
          : 'The latest memories are less about isolated facts and more about how you decide, what you keep returning to, and which contexts deserve follow-through.',
    },
    {
      kicker: 'Notable Notes',
      title: 'A few memories are now anchors',
      body: niceList(recentTitles.map(title => `"${clampText(title, 72)}"`)) + '.',
    },
  ]

  if (inboxItems.length) {
    cards.push({
      kicker: 'Inbox',
      title: `${inboxItems.length} item${inboxItems.length === 1 ? '' : 's'} still need a decision`,
      body: 'The digest can stay reflective, but these are the few places where the system is asking you to choose, archive, or confirm relevance.',
    })
  }

  return {
    headline,
    subhead,
    opener: 'Here is the higher-level read, not a raw changelog: what seems to be moving, what pattern is emerging, and what might be worth noticing before the week resets.',
    cards,
    questions: [
      `Is ${primaryTheme || 'this cluster'} genuinely important, or just recently noisy?`,
      'What would be useful to decide once, so future-you does not have to re-think it from scratch?',
      'Is any memory here becoming outdated because your actual preference has shifted?',
    ],
    footer_note: inboxItems.length ? 'There are inbox items waiting for review.' : 'No inbox maintenance is waiting right now.',
  }
}

function normalizeDigest(value: Partial<ReflectionDigest> | null, fallback: ReflectionDigest): ReflectionDigest {
  if (!value) return fallback
  const cards = Array.isArray(value.cards)
    ? value.cards
        .filter(card => card?.title && card?.body)
        .slice(0, 4)
        .map(card => ({
          kicker: clampText(card.kicker || 'Signal', 28),
          title: clampText(card.title, 90),
          body: clampText(card.body, 420),
        }))
    : fallback.cards
  const questions = Array.isArray(value.questions)
    ? value.questions.filter(Boolean).slice(0, 3).map(q => clampText(q, 160))
    : fallback.questions
  return {
    headline: clampText(value.headline || fallback.headline, 90),
    subhead: clampText(value.subhead || fallback.subhead, 150),
    opener: clampText(value.opener || fallback.opener, 380),
    cards: cards.length ? cards : fallback.cards,
    questions: questions.length ? questions : fallback.questions,
    footer_note: clampText(value.footer_note || fallback.footer_note, 180),
  }
}

async function buildAiDigest(entries: DigestEntry[], inboxItems: InboxItem[], fallback: ReflectionDigest) {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY')
  if (!apiKey || !entries.length) {
    return { digest: fallback, aiUsed: false, aiError: null as string | null }
  }

  const payload = {
    entries: entries.slice(0, 12).map(entry => ({
      title: entry.title,
      body: clampText(entry.body, 700),
      space: entry.space,
      layer: entry.layer,
      perishability: entry.perishability,
      tags: entry.tags || [],
      updated_at: entry.updated_at,
    })),
    inbox: inboxItems.slice(0, 8).map(item => ({
      type: item.type,
      title: item.title,
      space: item.space,
      deadline: item.deadline,
    })),
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('DEEPSEEK_MODEL') || 'deepseek-chat',
        temperature: 0.45,
        max_tokens: 1100,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You write a weekly reflective digest for one person from their personal second brain.',
              'Be specific, thoughtful, warm, and concise. Do not sound corporate. Do not list every entry.',
              'Infer trends carefully. If evidence is thin, say so gently. No hype, no action list unless inbox items need review.',
              'Return only valid JSON with keys: headline, subhead, opener, cards, questions, footer_note.',
              'cards must be 3 or 4 objects with kicker, title, body. Each body max 60 words.',
              'questions must be 2 or 3 reflective questions.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify(payload),
          },
        ],
      }),
    })

    if (!response.ok) {
      return { digest: fallback, aiUsed: false, aiError: await response.text() }
    }
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    const parsed = JSON.parse(content)
    return { digest: normalizeDigest(parsed, fallback), aiUsed: true, aiError: null as string | null }
  } catch (err) {
    return { digest: fallback, aiUsed: false, aiError: String(err) }
  }
}

function renderCard(card: DigestCard) {
  return `
        <tr>
          <td style="padding:0 0 12px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fffaf2;border:1px solid #eadfce;border-radius:14px;">
              <tr>
                <td style="padding:16px 16px 15px;">
                  <div style="font-size:11px;line-height:1.25;letter-spacing:.08em;text-transform:uppercase;color:#9a6a26;font-weight:800;margin-bottom:7px;">${escapeHtml(card.kicker)}</div>
                  <div style="font-size:18px;line-height:1.25;color:#241f1a;font-weight:800;margin-bottom:8px;">${escapeHtml(card.title)}</div>
                  <div style="font-size:15px;line-height:1.55;color:#51483f;">${escapeHtml(card.body)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
}

function renderInboxHtml(inboxItems: InboxItem[]) {
  if (!inboxItems.length) {
    return '<div style="font-size:15px;line-height:1.55;color:#5f554b;">Clear. Nothing needs a decision right now.</div>'
  }

  return inboxItems.slice(0, 6).map(item => {
    const deadline = item.deadline
      ? new Date(item.deadline).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })
      : 'No deadline'
    const type = item.type === 'coherence_conflict' ? 'Coherence'
      : item.type === 'decay_review' ? 'Decay'
      : 'Review'
    return `
      <div style="padding:12px 0;border-top:1px solid #eee5d8;">
        <div style="font-size:14px;line-height:1.35;color:#2b251f;font-weight:800;">${escapeHtml(item.title || 'Untitled review')}</div>
        <div style="font-size:12px;line-height:1.4;color:#7a6c5e;margin-top:3px;">${escapeHtml(type)} · ${escapeHtml(item.space || 'unknown')} · due ${escapeHtml(deadline)}</div>
      </div>`
  }).join('')
}

function buildDigestEmail(input: {
  digest: ReflectionDigest
  inboxItems: InboxItem[]
  periodLabel: string
  generatedLabel: string
  aiUsed: boolean
}) {
  const { digest, inboxItems, periodLabel, generatedLabel, aiUsed } = input
  const questionsHtml = digest.questions.map(question => `
        <tr>
          <td style="padding:0 0 10px;">
            <div style="font-size:15px;line-height:1.5;color:#3c352e;background:#ffffff;border-left:3px solid #2f7d50;padding:11px 13px;border-radius:8px;">${escapeHtml(question)}</div>
          </td>
        </tr>`).join('')

  const text = [
    'Second Brain weekly reflection',
    periodLabel,
    '',
    digest.headline,
    digest.subhead,
    '',
    digest.opener,
    '',
    ...digest.cards.flatMap(card => [`${card.kicker}: ${card.title}`, card.body, '']),
    'Questions to keep warm:',
    ...digest.questions.map(q => `- ${q}`),
    '',
    'Inbox maintenance:',
    inboxItems.length ? inboxItems.map(i => `- ${i.title}`).join('\n') : 'Clear. Nothing needs a decision right now.',
    '',
    `Open inbox: ${appInboxUrl}`,
  ].join('\n')

  const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="x-apple-disable-message-reformatting">
    <title>Second Brain weekly reflection</title>
  </head>
  <body style="margin:0;padding:0;background:#f4efe7;color:#241f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">${escapeHtml(digest.subhead)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4efe7;">
      <tr>
        <td align="center" style="padding:18px 10px 28px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;">
            <tr>
              <td style="padding:4px 2px 13px;">
                <div style="font-size:12px;line-height:1.35;letter-spacing:.11em;text-transform:uppercase;color:#2f7d50;font-weight:900;">Second Brain</div>
                <div style="font-size:12px;line-height:1.4;color:#7b6e61;margin-top:3px;">${escapeHtml(periodLabel)} · ${escapeHtml(generatedLabel)} · ${aiUsed ? 'AI reflection' : 'Pattern reflection'}</div>
              </td>
            </tr>
            <tr>
              <td style="background:#173b31;border-radius:18px;padding:23px 20px 22px;">
                <div style="font-size:30px;line-height:1.12;color:#fff8ed;font-weight:850;letter-spacing:0;margin:0 0 10px;">${escapeHtml(digest.headline)}</div>
                <div style="font-size:16px;line-height:1.5;color:#d9eadc;">${escapeHtml(digest.subhead)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:17px 2px 14px;">
                <div style="font-size:17px;line-height:1.55;color:#362f28;">${escapeHtml(digest.opener)}</div>
              </td>
            </tr>
            ${digest.cards.map(renderCard).join('')}
            <tr>
              <td style="padding:4px 0 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eaf3ec;border:1px solid #d2e4d7;border-radius:14px;">
                  <tr>
                    <td style="padding:16px;">
                      <div style="font-size:11px;line-height:1.25;letter-spacing:.08em;text-transform:uppercase;color:#2f7d50;font-weight:900;margin-bottom:9px;">Questions to keep warm</div>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${questionsHtml}</table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 0 16px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #eadfce;border-radius:14px;">
                  <tr>
                    <td style="padding:16px;">
                      <div style="font-size:11px;line-height:1.25;letter-spacing:.08em;text-transform:uppercase;color:#817163;font-weight:900;margin-bottom:5px;">Inbox maintenance</div>
                      ${renderInboxHtml(inboxItems)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:2px 0 19px;">
                <a href="${appInboxUrl}" style="display:block;text-align:center;background:#2f7d50;color:#ffffff;text-decoration:none;border-radius:12px;padding:15px 16px;font-size:16px;line-height:1.2;font-weight:850;">Open Second Brain</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 2px;">
                <div style="font-size:12px;line-height:1.55;color:#85776a;">${escapeHtml(digest.footer_note)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { html, text }
}

async function sendResendEmail(input: {
  to: string
  subject: string
  html: string
  text: string
}) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    return { sent: false, skippedReason: 'missing_resend_api_key', error: null }
  }

  const from = Deno.env.get('RESEND_FROM_EMAIL') || 'Second Brain <onboarding@resend.dev>'
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      tags: [
        { name: 'app', value: 'second-brain' },
        { name: 'kind', value: 'weekly-digest' },
      ],
    }),
  })

  if (response.ok) {
    const data = await response.json().catch(() => ({}))
    return { sent: true, skippedReason: null, error: null, providerId: data?.id ?? null }
  }

  const text = await response.text()
  return { sent: false, skippedReason: 'email_send_failed', error: text || response.statusText }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const options = req.method === 'POST'
    ? await req.json().catch(() => ({}))
    : {}
  const sendEmail = options.send_email !== false

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    // Get all users (single user system — just get the first)
    const { data: spaces } = await supabase
      .from('spaces')
      .select('user_id')
      .eq('is_core', true)
      .limit(1)

    if (!spaces?.length) {
      return new Response(JSON.stringify({ message: 'No users found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const userId = spaces[0].user_id

    // Run decay scan
    const { data: decayCount } = await supabase
      .rpc('run_decay_scan', { p_user_id: userId })

    // Run coherence scan
    const { data: coherenceCount } = await supabase
      .rpc('run_coherence_scan', { p_user_id: userId })

    // Get total pending inbox count
    const { count: pendingCount } = await supabase
      .from('review_inbox')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'pending')

    // Auto-expire overdue items
    const { count: expiredCount } = await supabase
      .from('review_inbox')
      .update({ status: 'expired' })
      .eq('user_id', userId)
      .eq('status', 'pending')
      .lt('deadline', new Date().toISOString())

    // Get user settings for email
    const { data: settings } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single()

    const since = new Date(Date.now() - 7 * 86400000).toISOString()

    // Get recent entries and audit activity for reflective digest.
    const { data: recentEntries } = await supabase
      .from('entries')
      .select('title,body,space,layer,perishability,tags,updated_at,created_by_tool,status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(12)

    const { data: recentEdits } = await supabase
      .from('context_edits')
      .select('action,space,timestamp,entry_after')
      .eq('user_id', userId)
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(20)

    const recentList: DigestEntry[] = recentEntries || []
    const editList = recentEdits || []

    const hasReflectionActivity = recentList.length > 0 || editList.length > 0

    // Get inbox breakdown for the operational section.
    const { data: inboxItems } = await supabase
      .from('review_inbox')
      .select('type, title, deadline, space')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('deadline', { ascending: true })
      .limit(10)

    const inboxList: InboxItem[] = inboxItems || []

    let emailSent = false
    let emailError: string | null = null
    let aiUsed = false
    let aiError: string | null = null

    // Send weekly digest if Resend is configured and there is reflection or inbox activity.
    const shouldSendEmail = !!(
      settings?.email &&
      sendEmail &&
      (hasReflectionActivity || (pendingCount ?? 0) > 0)
    )

    if (shouldSendEmail) {
      const now = new Date()
      const periodStart = new Date(Date.now() - 7 * 86400000)
      const periodLabel = `${periodStart.toLocaleDateString('en-SG', {
        day: 'numeric',
        month: 'short',
      })} to ${now.toLocaleDateString('en-SG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })}`
      const subject = `Second Brain weekly reflection — ${new Date().toLocaleDateString('en-SG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })}`
      const fallbackDigest = buildDeterministicDigest(recentList, inboxList)
      const aiDigest = await buildAiDigest(recentList, inboxList, fallbackDigest)
      const digest = aiDigest.digest
      aiUsed = aiDigest.aiUsed
      aiError = aiDigest.aiError
      const { html, text } = buildDigestEmail({
        digest,
        inboxItems: inboxList,
        periodLabel,
        generatedLabel: now.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' }),
        aiUsed,
      })

      const result = await sendResendEmail({
        to: settings.email,
        subject,
        html,
        text,
      })
      emailSent = result.sent
      emailError = result.error
    }

    const emailSkippedReason = emailSent ? null
      : emailError ? 'email_send_failed'
      : !sendEmail ? 'send_email_false'
      : !hasReflectionActivity && (pendingCount ?? 0) === 0 ? 'no_reflection_or_inbox_activity'
      : !settings?.email ? 'missing_email'
      : !Deno.env.get('RESEND_API_KEY') ? 'missing_resend_api_key'
      : 'unknown'

    return new Response(JSON.stringify({
      success: true,
      decay_flagged:       decayCount ?? 0,
      coherence_flagged:   coherenceCount ?? 0,
      total_pending:       pendingCount ?? 0,
      expired:             expiredCount ?? 0,
      reflection_items:    recentList.length,
      ai_reflection_used:  aiUsed,
      ai_reflection_error: aiError,
      email_sent:          emailSent,
      email_skipped_reason: emailSkippedReason,
      email_error:         emailError
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('weekly-scan error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
