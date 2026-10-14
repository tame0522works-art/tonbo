/**
 * 時間のかかる読み取りの進み具合を知らせる。
 * 読み取りは画面と同じスレッドで動くので、ずっと続けると画面が固まり、進み具合も描かれない。
 * そこで前に譲ってから 50ms たったら、いったん setTimeout で画面に描き直す隙を作る
 */
export type OnProgress = (done: number, total: number) => void

export class Progress {
  private last = performance.now()
  private readonly total: number
  private readonly onProgress?: OnProgress
  constructor(total: number, onProgress?: OnProgress) {
    this.total = total
    this.onProgress = onProgress
  }

  async step(done: number): Promise<void> {
    if (!this.onProgress) return
    if (performance.now() - this.last < 50 && done < this.total) return
    this.onProgress(done, this.total)
    await new Promise((r) => setTimeout(r, 0))
    this.last = performance.now()
  }
}
