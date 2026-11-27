/**
 * Generic in-process Single-Flight request coalescer.
 * Menggabungkan beberapa eksekusi asinkron bersamaan dengan key identik
 * agar operasi mahal/eksternal (charge payment gateway, cek status, agregasi laporan)
 * hanya dieksekusi sekali sambil berbagi hasil yang sama ke seluruh pemanggil paralel.
 *
 * Dirancang modular agar dapat dipakai lintas modul (QRIS, Promo, Laporan Admin)
 * atau diganti dengan koordinator terdistribusi di masa depan tanpa mengubah pemanggil.
 */
export interface FlightCoordinator {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  isInFlight(key: string): boolean;
  size(): number;
}

export class SingleFlightCoordinator implements FlightCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  size(): number {
    return this.inFlight.size;
  }
}

export const singleFlight = new SingleFlightCoordinator();
