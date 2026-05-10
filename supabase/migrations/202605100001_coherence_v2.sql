-- ============================================================
-- Second Brain Manager — Coherence V2
-- Richer review_inbox payloads for merge/supersede decisions.
-- Safe to rerun: replaces only the scanner function.
-- ============================================================

CREATE OR REPLACE FUNCTION run_coherence_scan(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
  v_a entries%ROWTYPE;
  v_b entries%ROWTYPE;
  v_sim float;
  v_classification text;
  v_confidence text;
  v_recommendation text;
  v_rationale text;
  v_merge_title text;
  v_merge_body text;
  v_merge_tags text[];
  v_merge_perishability text;
BEGIN
  FOR v_a IN
    SELECT * FROM entries
    WHERE user_id = p_user_id AND status = 'active' AND embedding IS NOT NULL
    ORDER BY created_at
  LOOP
    FOR v_b IN
      SELECT * FROM entries
      WHERE user_id    = p_user_id
        AND status     = 'active'
        AND embedding  IS NOT NULL
        AND id         > v_a.id
        AND space      = v_a.space
        AND layer      = v_a.layer
    LOOP
      v_sim := 1 - (v_a.embedding <=> v_b.embedding);

      IF v_sim >= 0.88 THEN
        IF NOT EXISTS (
          SELECT 1 FROM review_inbox ri
          WHERE ri.type = 'coherence_conflict'
            AND ri.status = 'pending'
            AND (
              (ri.entry_id_a = v_a.id AND ri.entry_id_b = v_b.id)
              OR (ri.entry_id_a = v_b.id AND ri.entry_id_b = v_a.id)
            )
        ) THEN
          v_classification := CASE
            WHEN lower(v_a.title) = lower(v_b.title) OR v_sim >= 0.96 THEN 'duplicate'
            WHEN v_a.updated_at > v_b.updated_at + INTERVAL '14 days'
              OR v_b.updated_at > v_a.updated_at + INTERVAL '14 days' THEN 'likely_superseded'
            WHEN v_sim >= 0.91 THEN 'merge_candidate'
            ELSE 'weak_overlap'
          END;

          v_confidence := CASE
            WHEN v_sim >= 0.96 THEN 'high'
            WHEN v_sim >= 0.91 THEN 'medium'
            ELSE 'low'
          END;

          v_recommendation := CASE v_classification
            WHEN 'duplicate' THEN 'merge_or_archive_duplicate'
            WHEN 'likely_superseded' THEN
              CASE WHEN v_a.updated_at >= v_b.updated_at THEN 'keep_a_archive_b' ELSE 'keep_b_archive_a' END
            WHEN 'merge_candidate' THEN 'merge_review'
            ELSE 'keep_both_review'
          END;

          v_rationale := CASE v_classification
            WHEN 'duplicate' THEN 'These entries are nearly identical in meaning. Keeping both may add noise.'
            WHEN 'likely_superseded' THEN 'The entries strongly overlap, but one is noticeably newer and may supersede the older memory.'
            WHEN 'merge_candidate' THEN 'The entries overlap enough that a merged memory may be clearer than keeping two fragments.'
            ELSE 'The entries are related, but may represent distinct contexts. Review before merging.'
          END;

          v_merge_title := CASE
            WHEN length(v_a.title) <= length(v_b.title) THEN v_a.title ELSE v_b.title
          END;
          v_merge_body := concat_ws(E'\n\n',
            'Merged coherence proposal:',
            trim(v_a.body),
            trim(v_b.body)
          );
          v_merge_tags := (
            SELECT coalesce(array_agg(DISTINCT tag ORDER BY tag), ARRAY[]::text[])
            FROM unnest(coalesce(v_a.tags, ARRAY[]::text[]) || coalesce(v_b.tags, ARRAY[]::text[])) AS tag
          );
          v_merge_perishability := CASE
            WHEN v_a.perishability = 'fast' OR v_b.perishability = 'fast' THEN 'fast'
            WHEN v_a.perishability = 'single_use' OR v_b.perishability = 'single_use' THEN 'single_use'
            WHEN v_a.perishability = 'evergreen' AND v_b.perishability = 'evergreen' THEN 'evergreen'
            ELSE 'slow'
          END;

          INSERT INTO review_inbox (
            user_id, type, title, description, space, layer,
            entry_id_a, entry_id_b, payload, deadline
          ) VALUES (
            p_user_id,
            'coherence_conflict',
            CASE v_classification
              WHEN 'duplicate' THEN 'Duplicate memory: "' || left(v_a.title, 42) || '"'
              WHEN 'likely_superseded' THEN 'Possible superseded memory: "' || left(v_a.title, 34) || '"'
              WHEN 'merge_candidate' THEN 'Merge candidate: "' || left(v_a.title, 36) || '"'
              ELSE 'Related memories: "' || left(v_a.title, 38) || '"'
            END,
            v_rationale || ' Similarity: ' || round((v_sim * 100)::numeric, 0) || '%.',
            v_a.space,
            v_a.layer::text,
            v_a.id,
            v_b.id,
            jsonb_build_object(
              'version', 2,
              'classification', v_classification,
              'confidence', v_confidence,
              'recommendation', v_recommendation,
              'rationale', v_rationale,
              'similarity', v_sim,
              'entry_a', to_jsonb(v_a),
              'entry_b', to_jsonb(v_b),
              'comparison', jsonb_build_object(
                'same_space', v_a.space = v_b.space,
                'same_layer', v_a.layer = v_b.layer,
                'a_newer', v_a.updated_at >= v_b.updated_at,
                'b_newer', v_b.updated_at > v_a.updated_at,
                'shared_tags', (
                  SELECT coalesce(jsonb_agg(DISTINCT tag), '[]'::jsonb)
                  FROM unnest(coalesce(v_a.tags, ARRAY[]::text[])) AS tag
                  WHERE tag = ANY(coalesce(v_b.tags, ARRAY[]::text[]))
                )
              ),
              'merge_candidate', jsonb_build_object(
                'title', v_merge_title,
                'body', v_merge_body,
                'space', v_a.space,
                'layer', v_a.layer::text,
                'perishability', v_merge_perishability,
                'tags', v_merge_tags
              )
            ),
            NOW() + INTERVAL '14 days'
          );
          v_count := v_count + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_count;
END;
$$;
