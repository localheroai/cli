export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private interval: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private message: string;

  constructor(message: string = 'Loading...') {
    this.message = message;
  }

  start(): void {
    if (!process.stdout.isTTY || process.env.GITHUB_ACTIONS === 'true') {
      return;
    }

    if (this.interval) {
      return;
    }

    // Hide cursor
    process.stdout.write('\x1B[?25l');

    this.interval = setInterval(() => {
      process.stdout.write(`\r${this.frames[this.currentFrame]} ${this.message}`);
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 100);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      // Clear the line and show cursor
      process.stdout.write('\r\x1B[K\x1B[?25h');
    }
  }
}
