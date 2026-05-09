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

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textToHtml(value: string) {
  return escapeHtml(value)
    .split('\n\n')
    .map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('')
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

    const recentList = recentEntries || []
    const editList = recentEdits || []
    const spaceCounts = recentList.reduce((acc, entry) => {
      acc[entry.space] = (acc[entry.space] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    const layerCounts = recentList.reduce((acc, entry) => {
      acc[entry.layer] = (acc[entry.layer] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    const tagCounts = recentList.flatMap(e => e.tags || []).reduce((acc, tag) => {
      acc[tag] = (acc[tag] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    const top = (counts: Record<string, number>) => Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`)
      .join(', ')

    const recentEntryLines = recentList.slice(0, 8).map(entry => {
      const preview = (entry.body || '').replace(/\s+/g, ' ').slice(0, 180)
      return `• ${entry.title} [${entry.space} · ${entry.layer}]: ${preview}${preview.length >= 180 ? '…' : ''}`
    }).join('\n')

    const reflectionSummary = recentList.length
      ? [
          `Current signal: ${recentList.length} active memor${recentList.length === 1 ? 'y' : 'ies'} changed in the last 7 days.`,
          top(spaceCounts) ? `Most active spaces: ${top(spaceCounts)}.` : '',
          top(layerCounts) ? `Most active layers: ${top(layerCounts)}.` : '',
          top(tagCounts) ? `Recurring tags: ${top(tagCounts)}.` : '',
          '',
          'Recent memory signals:',
          recentEntryLines
        ].filter(Boolean).join('\n')
      : 'No active memories changed in the last 7 days. The system looks quiet this week.'

    const reflectionPrompt = [
      'For perspective:',
      recentList.length
        ? 'Look for whether these recent memories suggest a shift in focus, a recurring theme, or a decision pattern worth noticing.'
        : 'Quiet weeks are also signal: fewer memory changes may mean stability, low capture, or fewer second-brain-worthy conversations.'
    ].join('\n')

    const hasReflectionActivity = recentList.length > 0 || editList.length > 0

    // Get inbox breakdown for the operational section.
    const { data: inboxItems } = await supabase
      .from('review_inbox')
      .select('type, title, deadline, space')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('deadline', { ascending: true })
      .limit(10)

    const breakdown = (inboxItems || [])
      .map(item => {
        const icon = item.type === 'coherence_conflict' ? '🔴' :
                     item.type === 'decay_review' ? '🟡' : '🔵'
        const deadline = new Date(item.deadline).toLocaleDateString('en-SG', {
          day: 'numeric', month: 'short'
        })
        return `${icon} ${item.title} — due ${deadline}`
      })
      .join('\n')

    let emailSent = false
    let emailError: string | null = null

    // Send weekly digest if Resend is configured and there is reflection or inbox activity.
    const shouldSendEmail = !!(
      settings?.email &&
      sendEmail &&
      (hasReflectionActivity || (pendingCount ?? 0) > 0)
    )

    if (shouldSendEmail) {
      const subject = `Second Brain weekly reflection — ${new Date().toLocaleDateString('en-SG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })}`
      const inboxSummary = breakdown || 'No pending inbox items.'
      const text = [
        'Second Brain weekly reflection',
        '',
        reflectionSummary,
        '',
        reflectionPrompt,
        '',
        'Inbox maintenance:',
        inboxSummary,
        '',
        `Open inbox: ${appInboxUrl}`,
      ].join('\n')
      const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f6f3ee;color:#2a2520;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.55;">
    <div style="max-width:680px;margin:0 auto;padding:28px 18px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#2f7d50;font-weight:700;margin-bottom:8px;">Second Brain</div>
      <h1 style="font-size:26px;line-height:1.2;margin:0 0 18px;">Weekly reflection</h1>
      <section style="background:#ffffff;border:1px solid #e5ddd1;border-radius:8px;padding:18px;margin-bottom:14px;">
        <h2 style="font-size:17px;margin:0 0 12px;">Perspective</h2>
        ${textToHtml(reflectionSummary)}
        <div style="margin-top:14px;color:#685f54;">${textToHtml(reflectionPrompt)}</div>
      </section>
      <section style="background:#ffffff;border:1px solid #e5ddd1;border-radius:8px;padding:18px;margin-bottom:18px;">
        <h2 style="font-size:17px;margin:0 0 12px;">Inbox maintenance</h2>
        ${textToHtml(inboxSummary)}
      </section>
      <a href="${appInboxUrl}" style="display:inline-block;background:#2f7d50;color:#fff;text-decoration:none;border-radius:7px;padding:11px 15px;font-weight:700;">Open Second Brain inbox</a>
    </div>
  </body>
</html>`

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
