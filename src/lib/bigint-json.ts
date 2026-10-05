// Brand.salesCents / fundingCents are BigInt (integer cents past $21M).
// JSON.stringify throws on a bigint, and many handlers send whole Brand
// rows to the page, so teach BigInt to serialize as a plain number —
// exact up to 2^53 cents (~$90 trillion). Imported for its side effect by
// every API route that can return a Brand row.
const proto = BigInt.prototype as unknown as { toJSON?: () => number }
if (!proto.toJSON) proto.toJSON = function (this: bigint) { return Number(this) }

export {}
