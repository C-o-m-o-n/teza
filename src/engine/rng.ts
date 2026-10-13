// Park–Miller LCG, the same generator TETR.IO uses for bags and garbage holes,
// so a given seed yields the same piece sequence as the official game.
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed % 2147483647;
    if (this.s <= 0) this.s = this.s + 2147483646 || 1;
  }

  next(): number {
    this.s = (16807 * this.s) % 2147483647;
    return this.s;
  }

  nextFloat(): number {
    return (this.next() - 1) / 2147483646;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.nextFloat() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
