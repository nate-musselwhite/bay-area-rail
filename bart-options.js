const MINUTE = 60000;
const DEPARTURE_WINDOW = 120 * MINUTE;
const MAX_TRANSFER_WAIT = 60 * MINUTE;
const MATCH_TOLERANCE = 90_000;

const list = value => Array.isArray(value) ? value : value ? [value] : [];
const stopKey = (station,line,terminal) => [station,line,terminal].join('|');

export function bartDeparturePredictions(payload,now) {
  const root = payload?.root;
  const stamp = Date.parse(root?.date + ' ' + root?.time);
  if (!Number.isFinite(stamp) || now-stamp > 3*MINUTE || stamp-now > MINUTE) return [];
  return list(root?.station).flatMap(station => list(station.etd).flatMap(group =>
    list(group.estimate).flatMap(estimate => {
      const leaving = String(estimate.minutes).toLowerCase() === 'leaving';
      const minutes = leaving ? 0 : Number(estimate.minutes);
      const delay = Number(estimate.delay);
      if (!station.abbr || !group.abbreviation || !estimate.color || estimate.minutes == null ||
          !Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(delay)) return [];
      const at = leaving ? Math.max(now,stamp) : stamp + minutes*MINUTE;
      if (at < now-MINUTE) return [];
      return [{station:station.abbr,line:estimate.color,terminal:group.abbreviation,
        platform:String(estimate.platform ?? ''),at,expectedSchedule:stamp+minutes*MINUTE-delay*1000,
        delay,canceled:String(estimate.cancelflag) === '1'}];
    })
  ));
}

function attachPredictions(trips,predictions,now) {
  const scheduledStops = new Map();
  for (const trip of trips) {
    const terminal = trip.stops.at(-1).station;
    for (const stop of trip.stops.slice(0,-1)) {
      if (!stop.pickup || stop.departure < now-180*MINUTE || stop.departure > now+180*MINUTE) continue;
      const key = stopKey(stop.station,trip.line,terminal);
      if (!scheduledStops.has(key)) scheduledStops.set(key,[]);
      scheduledStops.get(key).push({trip,stop});
    }
  }

  for (const estimate of predictions) {
    const group = scheduledStops.get(stopKey(estimate.station,estimate.line,estimate.terminal)) || [];
    const eligible = group.filter(({stop}) =>
      Math.abs(stop.departure-estimate.expectedSchedule) <= MATCH_TOLERANCE);
    const samePlatform = eligible.filter(({stop}) => estimate.platform && stop.platform === estimate.platform);
    const candidates = (samePlatform.length ? samePlatform : eligible).sort((a,b) =>
      Math.abs(a.stop.departure-estimate.expectedSchedule)-Math.abs(b.stop.departure-estimate.expectedSchedule));
    const [best,runnerUp] = candidates;
    if (!best || best.stop.prediction || (runnerUp && Math.abs(runnerUp.stop.departure-estimate.expectedSchedule) -
        Math.abs(best.stop.departure-estimate.expectedSchedule) < 30_000)) continue;
    best.stop.prediction = estimate;
    if (estimate.canceled) best.trip.canceled = true;
  }

  for (const trip of trips) {
    if (trip.canceled) continue;
    let offset = 0, previousDeparture = -Infinity, previousScheduledDeparture, hasPrediction = false;
    for (const stop of trip.stops) {
      const scheduledDeparture = stop.departure;
      if (stop.prediction) {
        offset = stop.prediction.at - scheduledDeparture;
        hasPrediction = true;
        if (stop.prediction.platform) stop.platform = stop.prediction.platform;
      }
      // Carry the last observed change forward. Minute-rounded predictions at
      // adjacent stations can disagree, so keep plausible running time.
      const runningTime = previousScheduledDeparture === undefined ? 0 :
        Math.max(0,stop.arrival-previousScheduledDeparture-MINUTE);
      stop.arrival = Math.max(previousDeparture+runningTime,stop.arrival+offset);
      stop.departure = Math.max(stop.arrival,scheduledDeparture+offset);
      stop.liveDeparture = stop.departure === stop.prediction?.at;
      stop.adjusted = hasPrediction;
      offset = stop.departure - scheduledDeparture;
      previousDeparture = stop.departure;
      previousScheduledDeparture = scheduledDeparture;
    }
  }
}


function runsOn(timetable,service,day) {
  const calendar = timetable.services[service];
  return timetable.exceptions[day.key]?.[service] ??
    Boolean(calendar && day.key >= calendar[0] && day.key <= calendar[1] && calendar[2][day.weekday] === '1');
}

function makeBoardings(timetable,days,now,predictions) {
  const trips = [];
  for (const day of days) {
    for (const [service,template,departures] of timetable.departures) {
      if (!runsOn(timetable,service,day)) continue;
      const [route,line,pattern] = timetable.templates[template];
      const lastDeparture = pattern.at(-1)[2];
      for (const departure of departures) {
        const start = day.zero + departure*1000;
        if (start + lastDeparture*1000 < now-(predictions.length ? 180*MINUTE : 0)) continue;
        const stops = pattern.map(([id,arrival,departure,pickup,dropoff]) => ({
          id,station:timetable.stations[id][0],platform:timetable.stations[id][1],
          arrival:start+arrival*1000,departure:start+departure*1000,pickup,dropoff
        }));
        trips.push({route,line,stops});
      }
    }
  }
  if (predictions.length) attachPredictions(trips,predictions,now);

  const byStation = new Map();
  for (const trip of trips) {
    if (trip.canceled) continue;
    for (const [index,stop] of trip.stops.entries()) {
      if (index === trip.stops.length-1 || !stop.pickup || stop.departure < now) continue;
      if (!byStation.has(stop.station)) byStation.set(stop.station,[]);
      byStation.get(stop.station).push({trip,index,at:stop.departure});
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
    line:board.trip.line,at:from.departure,arrival:to.arrival,
    departureKind:from.liveDeparture ? 'live' : from.adjusted ? 'estimated' : 'scheduled',
    arrivalKind:to.adjusted ? 'estimated' : 'scheduled',
    delay:from.liveDeparture ? from.prediction.delay : undefined};
}

export function planBartDepartures(timetable,days,stations,from,to,now,predictions = [],startAt = now) {
  const boards = makeBoardings(timetable,days,now,predictions);
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
            call.station === from && call.pickup && call.departure >= startAt);
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
  for (let i=firstAtOrAfter(firstBoards,startAt);i<firstBoards.length;i++) {
    const first = firstBoards[i];
    if (rows.length && first.at >= rows[0].at+DEPARTURE_WINDOW) break;
    // One row per first train. Prefer the quickest onward ride and avoid loops.
    let legs = search(first,0,new Set(),Infinity);
    if (!legs) {
      const one = search(first,1,new Set(),Infinity);
      const two = search(first,2,new Set(),one?.at(-1).arrival ?? Infinity);
      legs = two || one;
    }
    if (!legs) continue;
    const last = legs.at(-1);
    const live = legs.some(leg => leg.departureKind !== 'scheduled' || leg.arrivalKind !== 'scheduled');
    const mixed = live && legs.some(leg => leg.departureKind === 'scheduled' || leg.arrivalKind === 'scheduled');
    rows.push({headsign:stations[to] || to,at:first.at,arrival:last.arrival,
      arrivalKind:last.arrivalKind,line:first.trip.line,legs,live,mixed});
  }
  return rows;
}
