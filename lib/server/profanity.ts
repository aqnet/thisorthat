import 'server-only';
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';

/**
 * Server-side profanity filter for names, entries and room codes (§5, §8,
 * §14.1). The engine takes this as an injected predicate, so the word list
 * stays out of the pure module. The recommended transformers catch leetspeak
 * and spacing tricks ("b 4 d").
 */
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export function isProfane(text: string): boolean {
  return matcher.hasMatch(text);
}
