# REG-299: AST Track YieldExpression

**Linear Issue:** https://linear.app/reginaflow/issue/REG-299/ast-track-yieldexpression

## Gap
Yield expressions not tracked.

## Example

```javascript
function* gen() {
  yield 1;
  yield 2;
  yield* otherGen();
}
```

## Acceptance Criteria

- [ ] FUNCTION -[YIELDS]→ yielded value
- [ ] Track yield* delegation
- [ ] Track yielded value types when detectable

## Labels
- v0.1.x
- Feature

## Team
Reginaflow

## Created
2026-02-01

## Status
In Progress (as of 2026-02-14)
