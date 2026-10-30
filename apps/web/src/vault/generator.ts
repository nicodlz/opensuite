import { words } from "./words.ts";

export const characterClasses = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{}:,.?",
} as const;
export type CharacterClass = keyof typeof characterClasses;
export const classNames: CharacterClass[] = [
  "uppercase",
  "lowercase",
  "numbers",
  "symbols",
];
type RandomSource = (
  array: Uint32Array<ArrayBuffer>,
) => Uint32Array<ArrayBuffer>;
const secureRandom: RandomSource = (array) => crypto.getRandomValues(array);

/** Uniform integer in [0, bound); discard the incomplete tail of the range. */
export function randomIndex(
  bound: number,
  random: RandomSource = secureRandom,
): number {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 2 ** 32)
    throw new RangeError("Invalid random bound");
  const limit = Math.floor(2 ** 32 / bound) * bound;
  const sample = new Uint32Array(1);
  do {
    random(sample);
  } while ((sample[0] ?? 0) >= limit);
  return (sample[0] ?? 0) % bound;
}

function isEmptyClass(value: string | undefined): boolean {
  return !value;
}

export function generatePassword(
  length: number,
  selected: CharacterClass[],
  random: RandomSource = secureRandom,
): string {
  const classes = [...new Set(selected)].map((name) => characterClasses[name]);
  if (
    !Number.isInteger(length) ||
    length < 8 ||
    length > 128 ||
    classes.length === 0 ||
    classes.some(isEmptyClass)
  )
    throw new RangeError("Invalid password options");
  const alphabet = classes.join("");
  // Reject whole candidates missing a selected class; every accepted string has
  // the same probability, including when several classes are selected.
  let result: string;
  do {
    result = Array.from(
      { length },
      () => alphabet[randomIndex(alphabet.length, random)],
    ).join("");
  } while (
    !classes.every((group) =>
      Array.from(result).some((char) => group.includes(char)),
    )
  );
  return result;
}

export function generatePassphrase(
  count: number,
  separator: string,
  random: RandomSource = secureRandom,
): string {
  if (
    !Number.isInteger(count) ||
    count < 3 ||
    count > 12 ||
    !["-", " ", "."].includes(separator)
  )
    throw new RangeError("Invalid passphrase options");
  return Array.from(
    { length: count },
    () => words[randomIndex(words.length, random)],
  ).join(separator);
}
