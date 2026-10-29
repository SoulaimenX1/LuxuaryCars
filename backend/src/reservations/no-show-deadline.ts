export function noShowDeadlineExpression(graceMinutesParameter = '$1'): string {
    const grace = `(${graceMinutesParameter}::int * interval '1 minute')`;
    const timezone = `COALESCE(NULLIF(loc.timezone, ''), 'Europe/Budapest')`;
    const closingTime = `((r.pickup_at AT TIME ZONE ${timezone})::date + loc.closes_at) AT TIME ZONE ${timezone}`;

    return `CASE
        WHEN loc.closes_at IS NULL THEN r.pickup_at + ${grace}
        ELSE LEAST(r.pickup_at + ${grace}, ${closingTime})
    END`;
}
