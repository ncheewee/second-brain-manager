// ============================================================
// Edge Function: search-entries (v2 — uses service role key)
// Accepts a natural language query, generates its embedding,
// returns semantically similar entries for the authenticated user
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const {
      query,
      user_id,
      spaces,
      layer,
      threshold = 0.35,
      limit     = 10,
    } = await req.json()

    if (!query || !user_id) {
      return new Response(
        JSON.stringify({ error: 'query and user_id are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Generate embedding for the search query
    const model = new Supabase.ai.Session('gte-small')
    const queryEmbedding = await model.run(query, {
      mean_pool: true,
      normalize: true,
    })

    // Use service role key — user_id passed explicitly to SQL function
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data, error } = await supabase.rpc('search_entries_by_embedding', {
      query_embedding:  Array.from(queryEmbedding as number[]),
      search_user_id:   user_id,
      filter_spaces:    spaces ?? null,
      filter_layer:     layer  ?? null,
      match_threshold:  threshold,
      match_count:      limit,
    })

    if (error) throw error

    return new Response(
      JSON.stringify({ results: data }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('search-entries error:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
