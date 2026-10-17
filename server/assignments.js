// Legacy Mongo records may contain one UUID or null. New writes use sorted sets;
// ordering and representation alone must never manufacture assignment audits.
export function assignmentIds(value) {
  return [...new Set(Array.isArray(value) ? value : value == null ? [] : [value])].sort()
}

export function sameAssignments(left, right) {
  const a = assignmentIds(left)
  const b = assignmentIds(right)
  return a.length === b.length && a.every((id, index) => id === b[index])
}