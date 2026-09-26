/** The clock port: services read "now" through it so tests can control time (spec §5.3). */
export interface Clock {
  now(): Date;
}
