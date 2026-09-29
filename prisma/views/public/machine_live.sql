SELECT
  r.arcade_id,
  r.machine_id,
  (max(r.wait_count)) :: integer AS wait_count,
  (count(*)) :: integer AS wait_reports,
  max(r.created_at) AS wait_reported_at
FROM
  (
    machine_reports r
    CROSS JOIN report_settings cfg
  )
WHERE
  (
    (cfg.id = 1)
    AND (r.kind = 'queue' :: text)
    AND (
      r.created_at > (
        NOW() - make_interval(mins = > cfg.queue_ttl_minutes)
      )
    )
  )
GROUP BY
  r.arcade_id,
  r.machine_id;