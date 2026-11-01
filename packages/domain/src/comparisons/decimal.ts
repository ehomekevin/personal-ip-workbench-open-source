// 用十进制整数分数计算，避免大计数或小数经过 IEEE-754 后损失精度。
export interface Rational { numerator: bigint; denominator: bigint }
function reduced(value: Rational): Rational { let a = value.numerator < 0n ? -value.numerator : value.numerator, b = value.denominator < 0n ? -value.denominator : value.denominator; while (b !== 0n) { const next = a % b; a = b; b = next; } return { numerator: value.numerator / (a || 1n), denominator: value.denominator / (a || 1n) }; }
export function decimal(value: string): Rational | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 1000) return null;
  const [whole, fraction = ''] = value.split('.');
  return { numerator: BigInt(whole! + fraction), denominator: 10n ** BigInt(fraction.length) };
}
export function add(a: Rational, b: Rational): Rational { return reduced({ numerator: a.numerator * b.denominator + b.numerator * a.denominator, denominator: a.denominator * b.denominator }); }
export function subtract(a: Rational, b: Rational): Rational { return add(a, { ...b, numerator: -b.numerator }); }
export function divide(a: Rational, b: Rational): Rational { if (b.numerator === 0n) throw new Error('Undefined zero denominator'); return reduced({ numerator: a.numerator * b.denominator, denominator: a.denominator * b.numerator }); }
export function compare(a: Rational, b: Rational): number { const difference = a.numerator * b.denominator - b.numerator * a.denominator; return difference < 0n ? -1 : difference > 0n ? 1 : 0; }
export function render(value: Rational, precision = 12): string {
  let numerator = value.numerator, denominator = value.denominator;
  const negative = (numerator < 0n) !== (denominator < 0n); if (numerator < 0n) numerator = -numerator; if (denominator < 0n) denominator = -denominator;
  const scale = 10n ** BigInt(precision); const scaled = numerator * scale;
  let rounded = scaled / denominator; if ((scaled % denominator) * 2n >= denominator) rounded += 1n;
  const whole = rounded / scale, fractional = (rounded % scale).toString().padStart(precision, '0').replace(/0+$/, '');
  return `${negative && rounded !== 0n ? '-' : ''}${whole}${fractional ? '.' + fractional : ''}`;
}
export function renderPrecise(value: Rational): string { const numerator = value.numerator < 0n ? -value.numerator : value.numerator, denominator = value.denominator < 0n ? -value.denominator : value.denominator; return render(value, 12 + Math.max(0, denominator.toString().length - numerator.toString().length)); }
export function renderExact(value: Rational): string { let denominator = value.denominator < 0n ? -value.denominator : value.denominator, twos = 0, fives = 0; while (denominator % 2n === 0n) { denominator /= 2n; twos++; } while (denominator % 5n === 0n) { denominator /= 5n; fives++; } return render(value, denominator === 1n ? Math.max(1, twos, fives) : 12 + Math.max(0, value.denominator.toString().length - value.numerator.toString().replace('-', '').length)); }
export function total(values: string[]): Rational { return values.reduce((sum, value) => add(sum, decimal(value)!), { numerator: 0n, denominator: 1n }); }
export function median(values: string[]): Rational | null {
  const ordered = values.map(value => decimal(value)!).sort(compare); const middle = Math.floor(ordered.length / 2);
  if (!ordered.length) return null; return ordered.length % 2 ? ordered[middle]! : divide(add(ordered[middle - 1]!, ordered[middle]!), { numerator: 2n, denominator: 1n });
}
