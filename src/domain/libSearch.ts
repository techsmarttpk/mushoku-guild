// State of the Library search interface. The search field is hidden until the search button on the shelf is used.
export interface LibSearch {
  open: boolean;
  query: string;
}

export const CLOSED: LibSearch = { open: false, query: "" };

export type LibSearchAction = { type: "open" } | { type: "type"; query: string } | { type: "clear" } | { type: "close" } | { type: "blur" };

export function reduceLibSearch(s: LibSearch, a: LibSearchAction): LibSearch {
  switch (a.type) {
    case "open":
      return s.open ? s : { ...s, open: true };
    case "type":
      return { open: true, query: a.query };
    case "clear":
      return { ...s, query: "" };
    case "close":
      // closing always shows the full shelf again
      return CLOSED;
    case "blur":
      // leaving an empty field closes it; a field with text stays so the filtered shelf is not a mystery
      return s.query.trim() === "" ? CLOSED : s;
  }
}
