/**
 * Minimal RFC 4180 line parser for the generator's events.csv (quoted fields may
 * contain commas and doubled quotes; no field spans multiple lines).
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = "";
      i++;
      for (;;) {
        const quote = line.indexOf('"', i);
        if (quote === -1) throw new Error("unterminated quoted field");
        value += line.slice(i, quote);
        if (line[quote + 1] === '"') {
          value += '"';
          i = quote + 2;
        } else {
          i = quote + 1;
          break;
        }
      }
      fields.push(value);
      i++; // skip the comma
    } else {
      const comma = line.indexOf(",", i);
      const end = comma === -1 ? line.length : comma;
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

export interface CsvEvent {
  eventId: string;
  userId: string;
  sessionId: string;
  name: string;
  propsJson: string;
  clientTs: string;
  serverTs: string;
  os: string;
  model: string;
  network: string;
}

export const CSV_HEADER = "event_id,user_id,session_id,name,props_json,client_ts,server_ts,os,model,network";

export function toCsvEvent(fields: string[]): CsvEvent | null {
  if (fields.length !== 10) return null;
  const [eventId, userId, sessionId, name, propsJson, clientTs, serverTs, os, model, network] = fields as [
    string, string, string, string, string, string, string, string, string, string,
  ];
  return { eventId, userId, sessionId, name, propsJson, clientTs, serverTs, os, model, network };
}

/** The API request shape for one CSV row (props parsed; empty user_id = logged out). */
export function csvEventToApiEvent(e: CsvEvent): Record<string, unknown> {
  let props: unknown;
  try {
    props = JSON.parse(e.propsJson);
  } catch {
    props = e.propsJson; // left for the validator to reject as INVALID_PROPS
  }
  return {
    id: e.eventId,
    userId: e.userId === "" ? null : e.userId,
    sessionId: e.sessionId,
    name: e.name,
    props,
    clientTs: e.clientTs,
    device: { os: e.os, model: e.model, network: e.network },
  };
}