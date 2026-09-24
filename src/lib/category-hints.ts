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
//
// Leo's lanes are categories of their own (src/lib/stock.ts), so the
// specific drink, alcohol and apparel ones come before the broad ones
// they split out of. Alcohol before soft drinks, so "hard iced tea" is a
// can, not a tea; root and ginger beer stay soft drinks, and "cold brew"
// is coffee, not a brewery.
export const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/electrolyte|hydration/i, 'electrolytes'],
  [/energy drink|energy shot/i, 'energy'],
  [/nicotine|pouch|vape|tobacco|zyn/i, 'nicotine'],
  [/(?<!root |ginger )\bbeers?\b|brewing|brewery|breweries|hard seltzer|hard (iced )?tea|hard lemonade|\brtd\b|canned cocktail|\blager\b/i, 'rtd'],
  [/vodka|tequila|whiske?y|bourbon|\brum\b|\bgin\b|mezcal|spirits|distill|liquor/i, 'spirits'],
  [/seltzer water|sparkling water|soda|coffee|tea\b|juice|root beer|ginger beer/i, 'beverage'],
  [/snack|protein bar|jerky|chips|candy|cereal|granola/i, 'cpg'],
  [/athletic|activewear|athleisure|sportswear|sporting goods|gym wear|yoga wear/i, 'athletic'],
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

