const MINUTE = 60000;
const DEPARTURE_WINDOW = 120 * MINUTE;
const MAX_TRANSFER_WAIT = 60 * MINUTE;

function runsOn(timetable,service,day) {
  const calendar = timetable.services[service];
  return timetable.exceptions[day.key]?.[service] ??
    Boolean(calendar && day.key >= calendar[0] && day.key <= calendar[1] && calendar[2][day.weekday] === '1');
}

function makeBoardings(timetable,days,now) {
  const byStation = new Map();
  for (const day of days) {
    for (const [service,template,departures] of timetable.departures) {
      if (!runsOn(timetable,service,day)) continue;
      const [route,line,pattern] = timetable.templates[template];
      const lastDeparture = pattern.at(-1)[2];
      for (const departure of departures) {
        const start = day.zero + departure*1000;
        if (start + lastDeparture*1000 < now) continue;
        const stops = pattern.map(([id,arrival,departure,pickup,dropoff]) => ({
          id,station:timetable.stations[id][0],platform:timetable.stations[id][1],
          arrival:start+arrival*1000,departure:start+departure*1000,pickup,dropoff
        }));
        const trip = {route,line,stops};
        for (const [index,stop] of stops.entries()) {
          if (index === stops.length-1 || !stop.pickup || stop.departure < now) continue;
          if (!byStation.has(stop.station)) byStation.set(stop.station,[]);
          byStation.get(stop.station).push({trip,index,at:stop.departure});
        }
      }
    }
  }
  for (const boards of byStation.values()) boards.sort((a,b)=>a.at-b.at);
  return byStation;
}

function firstAtOrAfter(boards,earliest) {
  let start = 0, end = boards.length;
  while (start < end) {
    const middle = (start+end) >>> 1;
    if (boards[middle].at < earliest) start = middle+1;
    else end = middle;
  }
  return start;
}

function transferTime(timetable,left,right) {
  const start = left.trip.stops[left.index];
  const end = right.trip.stops[right.index];
  for (const routePair of [[left.trip.route,right.trip.route],[left.trip.route,''],['',right.trip.route],['','']]) {
    const minimum = timetable.minimums[[start.id,end.id,...routePair].join('|')];
    if (minimum !== undefined) return minimum < 0 ? Infinity : minimum*1000;
  }
  return 3*MINUTE;
}

function makeLeg(board,end,stations) {
  const stops = board.trip.stops;
  const from = stops[board.index], to = stops[end];
  const terminal = stops.at(-1).station;
  return {from:from.station,to:to.station,headsign:stations[terminal] || terminal,platform:from.platform,
    line:board.trip.line,at:from.departure,arrival:to.arrival};
}

export function planBartDepartures(timetable,days,stations,from,to,now) {
  const boards = makeBoardings(timetable,days,now);
  const firstBoards = boards.get(from) || [];
  const direct = new Map();

  for (const [station,options] of boards) {
    direct.set(station,options.flatMap(board => {
      const end = board.trip.stops.findIndex((stop,index)=>index > board.index && stop.station === to && stop.dropoff);
      return end < 0 ? [] : [{...board,end}];
    }));
  }

  function search(board,remaining,visited,arrivalLimit) {
    const stops = board.trip.stops;
    let best;
    const occupied = new Set(visited);
    occupied.add(stops[board.index].station);
    for (let end = board.index+1; end < stops.length; end++) {
      const stop = stops[end];
      if (occupied.has(stop.station) || stop.arrival >= arrivalLimit) break;
      if (stop.dropoff && stop.station === to) return [makeLeg(board,end,stations)];
      if (stop.dropoff && remaining > 0) {
        const candidates = (remaining === 1 ? direct : boards).get(stop.station) || [];
        for (let i = firstAtOrAfter(candidates,stop.arrival); i < candidates.length; i++) {
          const next = candidates[i];
          const latest = Math.min(stop.arrival+MAX_TRANSFER_WAIT,arrivalLimit);
          if (next.at > latest) break;
          if (next.trip === board.trip || next.at < stop.arrival + transferTime(timetable,{trip:board.trip,index:end},next)) continue;
          // Offer the onward train on its own when it can be boarded at the chosen origin.
          const boardsAtOrigin = next.trip.stops.slice(0,next.index).some(call =>
            call.station === from && call.pickup && call.departure >= now);
          if (boardsAtOrigin) continue;
          const rest = search(next,remaining-1,occupied,arrivalLimit);
          if (!rest) continue;
          best = [makeLeg(board,end,stations),...rest];
          arrivalLimit = best.at(-1).arrival;
        }
      }
      occupied.add(stop.station);
    }
    return best;
  }

  const rows = [];
  for (const first of firstBoards) {
    if (rows.length && first.at >= Math.max(now,rows[0].at)+DEPARTURE_WINDOW) break;
    // One row per first train. Prefer the quickest onward ride and avoid loops.
    let legs = search(first,0,new Set(),Infinity);
    if (!legs) {
      const one = search(first,1,new Set(),Infinity);
      const two = search(first,2,new Set(),one?.at(-1).arrival ?? Infinity);
      legs = two || one;
    }
    if (!legs) continue;
    rows.push({headsign:stations[to] || to,at:first.at,arrival:legs.at(-1).arrival,
      arrivalKind:'scheduled',line:first.trip.line,legs,live:false});
  }
  return rows;
}
