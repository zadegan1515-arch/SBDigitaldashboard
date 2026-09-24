// src/lib/category-hints.ts
//
// Keyword fallback for a brand's category — used when a brand is created
// without one (Discover imports, pasted lists, a LinkedIn capture of a
// brand the dashboard doesn't have yet). Pure, no dependencies.
//
// Deliberately conservative — it would rather return
// "unresolved" and let a human decide than confidently file a brand
// under the wrong category, because a miscategorised brand is invisible
// (nobody browses the category it landed in looking for it).
export const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/energy drink|seltzer water|sparkling water|hydration|electrolyte|soda|coffee|tea\b|juice/i, 'beverage'],
  [/nicotine|pouch|vape|tobacco|zyn/i, 'nicotine'],
  [/vodka|tequila|whiskey|beer|hard seltzer|rtd|spirits|brewing|distill/i, 'alcohol'],
  [/snack|protein bar|jerky|chips|candy|cereal|granola/i, 'cpg'],
  [/apparel|clothing|streetwear|sneaker|footwear|hoodie|denim/i, 'apparel'],
  [/sportsbook|betting|dfs|parlay|casino/i, 'betting'],
  [/bank|card|invest|trading|crypto|payments|fintech/i, 'fintech'],
  [/dating|social app|messaging app/i, 'apps'],
  [/skincare|grooming|deodorant|fragrance|cosmetic|beauty|haircare/i, 'beauty'],
  [/supplement|creatine|fitness|gym|recovery|sleep|wellness|vitamin/i, 'wellness'],
  [/pizza|burger|chicken|taco|restaurant|delivery|qsr|fast food/i, 'qsr'],
  [/tumbler|drinkware|cooler|bottle|furniture|bedding|home/i, 'home'],
  [/headphone|speaker|camera|charger|laptop|phone|gadget/i, 'tech'],
  [/\bai\b|software|saas|platform|app builder/i, 'software'],
  [/festival|concert|nightclub|dj\b|rave|edm/i, 'nightlife'],
  [/label|studio|streaming|sports team|league|esports/i, 'entertainment'],
]

export function guessCategory(name: string, hint?: string | null): string {
  const text = `${name} ${hint ?? ''}`
  for (const [pattern, key] of CATEGORY_HINTS) {
    if (pattern.test(text)) return key
  }
  return 'unresolved'
}

