SELECT
  c.id AS cabinet_id,
  (
    round(
      (
        (
          (
            COALESCE(rep.total, 0) + COALESCE((c.condition) :: integer, 0)
          )
        ) :: numeric / (
          NULLIF(
            (
              COALESCE(rep.n, 0) + CASE
                WHEN (c.condition IS NULL) THEN 0
                ELSE 1
              END
            ),
            0
          )
        ) :: numeric
      )
    )
  ) :: integer AS value,
  COALESCE(rep.n, 0) AS reports,
  rep.last_at AS reported_at
FROM
  (
    arcade_cabinets c
    LEFT JOIN (
      SELECT
        r.cabinet_id,
        (sum(r.condition)) :: integer AS total,
        (count(*)) :: integer AS n,
        max(r.created_at) AS last_at
      FROM
        (
          machine_reports r
          CROSS JOIN report_settings cfg
        )
      WHERE
        (
          (cfg.id = 1)
          AND (r.kind = 'condition' :: text)
          AND (r.cabinet_id IS NOT NULL)
          AND (
            r.created_at > (
              NOW() - make_interval(days = > cfg.condition_window_days)
            )
          )
        )
      GROUP BY
        r.cabinet_id
    ) rep ON ((rep.cabinet_id = c.id))
  );