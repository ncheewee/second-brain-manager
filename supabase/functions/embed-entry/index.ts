// ============================================================
// Edge Function: embed-entry
// Generates a vector embedding for a saved entry and stores it
// Called by Context Manager after every successful entry save
//
// Deploy name: embed-entry
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { entry_id, text } = await req.json()

    if (!entry_id || !text) {
      return new Response(
        JSON.stringify({ error: 'entry_id and text are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Use Supabase's built-in AI — no external API key needed
    // gte-small produces 384-dimensional embeddings
    const model = new Supabase.ai.Session('gte-small')
    const embedding = await model.run(text, {
      mean_pool: true,
      normalize: true,
    })

    // Use service role key to bypass RLS for this internal write
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { error } = await supabase
      .from('entries')
      .update({ embedding: Array.from(embedding as number[]) })
      .eq('id', entry_id)

    if (error) throw error

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('embed-entry error:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
