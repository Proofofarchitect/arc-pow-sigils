/**
 * The Twelve Rooms — puzzle-hunt config for /claim.
 *
 * Canonical spec: hunt spec · root brief: hunt brief.
 *
 * Statuses:
 *   - sealed → only the numeral renders (no titles/hints leak into the client bundle)
 *   - open   → visible hint + SOURCE payload (emitted as an HTML comment into the page source)
 *   - solved → kept for the archive; announced on X
 *
 * Release rule (hunt brief §4): addCodes(seal) BEFORE the site deploy that flips a room
 * to "open", then GitBook, then the entrance tweet — same day.
 */

export type RoomStatus = "sealed" | "open" | "solved";

export type Room = {
  n: number;
  roman: string;
  status: RoomStatus;
};

export type OpenRoom = {
  title: string;
  /** Visible hint paragraphs on /claim (EN). */
  visibleHint: string[];
  /**
   * Hidden piece: rendered VERBATIM inside an HTML comment in the page source
   * (view-source / curl only). Cryptic but deterministic; never the whole answer.
   */
  sourceComment: string;
};

export const HUNT_X_URL = "https://x.com/proof_of_arc";

export const ROOMS: Room[] = [
  { n: 1, roman: "I", status: "sealed" },
  { n: 2, roman: "II", status: "sealed" },
  { n: 3, roman: "III", status: "sealed" },
  { n: 4, roman: "IV", status: "sealed" },
  { n: 5, roman: "V", status: "sealed" },
  { n: 6, roman: "VI", status: "sealed" },
  { n: 7, roman: "VII", status: "sealed" },
  { n: 8, roman: "VIII", status: "sealed" },
  { n: 9, roman: "IX", status: "sealed" },
  { n: 10, roman: "X", status: "sealed" },
  { n: 11, roman: "XI", status: "sealed" },
  { n: 12, roman: "XII", status: "sealed" },
];

export const ROOM_CONTENT: Record<number, OpenRoom> = {};
