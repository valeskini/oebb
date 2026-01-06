"use strict";

const { journeys: validateArguments } =
	require("fpti-util").validateMethodArguments;
const merge = require("lodash/merge");
const getKey = require("lodash/get");
const isNumber = require("lodash/isNumber");
const first = require("lodash/first");
const last = require("lodash/last");
const omit = require("lodash/omit");
const take = require("lodash/take");
const uniqBy = require("lodash/uniqBy");
const flow = require("lodash/fp/flow");
const sortBy = require("lodash/fp/sortBy");
const { DateTime } = require("luxon");

const { createGet, createPost, auth } = require("./helpers");

const createPrice = (offer) => {
	if (!offer) return null;
	const { price, offerError, firstClass, availabilityState } = offer;
	if (
		!isNumber(price) ||
		Boolean(offerError) ||
		availabilityState !== "available"
	)
		return null;
	return {
		currency: "EUR", // @todo
		amount: price,
		firstClass,
	};
};

const oebbOperator = {
	type: "operator",
	id: "oebb",
	name: "Österreichische Bundesbahnen",
	url: "https://www.oebb.at/",
};

const createStation = (rawStation) => {
	const { name, esn } = rawStation;
	return {
		type: "station",
		id: String(esn),
		name,
	};
};

const formatDate = (date) => {
	const zone = "Europe/Vienna"; // sigh…, @todo
	return DateTime.fromISO(date, { zone }).toISO({
		suppressMilliseconds: true,
	});
};

const createLeg = (rawLeg) => {
	const { from, to, category, hasRealtime } = rawLeg;
	const { departure, departurePlatform = null } = from;
	const { arrival, arrivalPlatform = null } = to;
	const { name, number, shortName, longName, train } = category;
	const lineName = [name, number].filter(Boolean).join(" ");
	return {
		origin: createStation(from),
		destination: createStation(to),
		departure: formatDate(departure),
		departurePlatform,
		arrival: formatDate(arrival),
		arrivalPlatform,
		hasRealtimeInformation: hasRealtime,
		line: {
			type: "line",
			id: lineName,
			name: lineName,
			number,
			product: {
				name,
				shortName,
				longName,
			},
			mode: train ? "train" : "bus", // sigh…, @todo
			public: true,
			operator: oebbOperator, // sigh…, @todo
		},
		mode: train ? "train" : "bus", // sigh…, @todo
		public: true,
		operator: oebbOperator, // sigh…, @todo
	};
};

const createJourney = (rawJourney, offer) => {
	const { id, sections: rawLegs } = rawJourney;
	return {
		type: "journey",
		id,
		legs: rawLegs.map(createLeg),
		price: createPrice(offer),
	};
};

// default options
const defaults = () => ({
	when: null,
	departureAfter: null,
	results: null,
	transfers: null,
	interval: null,
	prices: true,
	passengers: [
		{
			type: "ADULT",
			count: 1,
		},
	],
	filters: {
		regionaltrains: false,
		direct: false,
		wheelchair: false,
		bikes: false,
		trains: false,
		motorail: false,
		connections: [],
	},
	sortType: "DEPARTURE",
});

const journeys = async (origin, destination, opt = {}) => {
	const def = defaults();
	if (!(opt.departureAfter || opt.when)) def.departureAfter = new Date();
	const options = merge({}, def, opt);
	validateArguments(origin, destination, options); // @todo
	if (typeof options.prices !== "boolean")
		throw new Error("`opt.prices` must be a boolean");

	if (typeof origin !== "string") origin = origin.id;
	if (typeof destination !== "string") destination = destination.id;

	// Build passenger data from options
	const buildPassengers = () => {
		if (Array.isArray(options.passengers) && options.passengers.length > 0) {
			return options.passengers.map((p, index) => ({
				me: index === 0,
				remembered: false,
				markedForDeath: false,
				challengedFlags: {
					hasHandicappedPass: p.challengedFlags?.hasHandicappedPass || false,
					hasAssistanceDog: p.challengedFlags?.hasAssistanceDog || false,
					hasWheelchair: p.challengedFlags?.hasWheelchair || false,
					hasAttendant: p.challengedFlags?.hasAttendant || false,
				},
				cards: p.cards || [],
				relations: [],
				id: Math.round(new Date() / 1000) + index,
				type: p.type || "ADULT",
			}));
		}
		return [
			{
				me: true,
				remembered: false,
				markedForDeath: false,
				challengedFlags: {
					hasHandicappedPass: false,
					hasAssistanceDog: false,
					hasWheelchair: false,
					hasAttendant: false,
				},
				cards: [],
				relations: [],
				id: Math.round(new Date() / 1000),
				type: "ADULT",
			},
		];
	};

	const date = new Date(options.when || options.departureAfter);
	const endDate = DateTime.fromJSDate(date)
		.plus({ minutes: options.interval || 0 })
		.toJSDate();

	// authenticate
	// @todo: don't create a new session per request
	const credentials = await auth();
	const get = createGet(credentials);
	const post = createPost(credentials);

	// fetch travel actions to obtain a travel action id (which references information
	// about the selected origin and destination)
	const { travelActions } = await post(
		"https://shop.oebbtickets.at/api/offer/v2/travelActions",
		{
			departureTime: true,
			from: {
				name: "blabla",
				number: Number(origin),
			},
			to: {
				name: "blabla",
				number: Number(destination),
			},
			datetime: DateTime.fromJSDate(date).toISO({ includeOffset: false }),
			customerVias: [],
			travelActionTypes: ["timetable"],
			filter: {
				productTypes: [],
				history: true,
				maxEntries: 10,
				channel: "inet",
			},
		}
	);
	const travelAction = travelActions.find(
		(travelAction) => getKey(travelAction, "entrypoint.id") === "timetable"
	);
	if (!travelAction) return []; // @todo throw an error here instead?
	const { id: travelActionId } = travelAction;

	let currentDate = date;
	let lastConnectionId = null;
	let journeys = [];
	const passengers = buildPassengers();

	// Determine how many pages to fetch (API returns 5 results per page)
	const resultsNeeded = options.results
		? Math.ceil(options.results / 5)
		: 1;

	// eslint-disable-next-line no-labels
	fetchJourneys: for (let page = 0; page < resultsNeeded; page++) {
		// use the travel action id to lookup journeys
		const endpoint = lastConnectionId
			? "https://shop.oebbtickets.at/api/hafas/v1/timetableScroll"
			: "https://shop.oebbtickets.at/api/hafas/v4/timetable";
		const { connections: rawJourneys } = await post(
			endpoint,
			omit(
				{
					travelActionId: travelActionId,
					datetimeDeparture: DateTime.fromJSDate(date).toISO({ includeOffset: false }),
					filter: options.filters,
					passengers: passengers,
					entryPointId: "timetable",
				count: 5,
					sortType: options.sortType,
					from: {
						name: "",
						number: Number(origin),
					},
					to: {
						name: "",
						number: Number(destination),
					},
					connectionId: lastConnectionId,
					direction: "after",
				},
				lastConnectionId
					? [
							"travelConnectionId",
							"datetimeDeparture",
							"datetimeArrival",
							"passengers",
					  ]
					: ["connectionId", "count", "direction"]
			)
		);

		// eslint-disable-next-line no-labels
		if (rawJourneys.length === 0) break fetchJourneys;

		const rawJourneyIds = rawJourneys.map(({ id }) => id);
		const { offers = [] } =
			options.prices && rawJourneyIds.length > 0
				? await get("https://shop.oebbtickets.at/api/offer/v1/prices", {
						connectionIds: rawJourneyIds,
						sortType: options.sortType,
				  })
				: {};

		const newJourneys = flow([
			(rawJourneys) =>
				rawJourneys.map((rawJourney) =>
					createJourney(
						rawJourney,
						offers.find(
							({ connectionId }) => connectionId === rawJourney.id
						)
					)
				),
			sortBy((journey) => +new Date(first(journey.legs).departure)),
		])(rawJourneys);
		journeys.push(...newJourneys);

		lastConnectionId = last(newJourneys).id;
	}

	journeys = uniqBy(journeys, "id");
	if (typeof options.interval === "number")
		journeys = journeys.filter(
			(j) => +new Date(first(j.legs).departure) <= +endDate
		);
	if (typeof options.transfers === "number")
		journeys = journeys.filter(
			(j) => j.legs.length <= options.transfers + 1
		);
	if (typeof options.results === "number")
		journeys = take(journeys, options.results);
	return journeys;
};
journeys.features = {
	// required by fpti
	results: "Max. number of results returned",
	when: "Journey date, synonym to departureAfter",
	departureAfter:
		"List journeys with a departure (first leg) after this date",
	interval:
		"Results for how many minutes after / before when (depending on whenRepresents)",
	transfers: "Max. number of transfers",
	prices: "Add price information to journeys",
	passengers: "Array of passenger objects with type and accessibility flags",
	filters: "Filter options for journey search (e.g., regionaltrains, direct, wheelchair, bikes)",
	sortType: "Sort type for results ('DEPARTURE' or other supported types)",
};

module.exports = journeys;
