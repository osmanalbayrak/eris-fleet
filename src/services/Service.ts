import {worker} from "cluster";
import {BaseServiceWorker} from "./BaseServiceWorker";
import {inspect} from "util";
import { IPC } from "../util/IPC";

interface ServiceInput {
	fetchTimeout: number;
}

export class Service {
	path!: string;
	serviceName!: string;
	app?: BaseServiceWorker;
	timeout!: number;
	whatToLog!: string[];
	ipc: IPC;

	constructor(input: ServiceInput) {
		this.ipc = new IPC({fetchTimeout: input.fetchTimeout});

		console.log = (str: unknown) => {this.ipc.log(str);};
		console.debug = (str: unknown) => {this.ipc.debug(str);};
		console.error = (str: unknown) => {this.ipc.error(str);};
		console.warn = (str: unknown) => {this.ipc.warn(str);};

		// Spawns
		process.on("uncaughtException", (err: Error) => {
			this.ipc.error(err);
		});

		process.on("unhandledRejection", (reason, promise) => {
			this.ipc.error("Unhandled Rejection at: " + inspect(promise) + " reason: " + reason);
		});

		if (process.send) process.send({op: "launched"});

		process.on("message", async message => {
			if (message.op) {
				switch (message.op) {
				case "connect": {
					this.path = message.path;
					this.serviceName = message.serviceName;
					this.timeout = message.timeout;
					this.whatToLog = message.whatToLog;
					this.loadCode();
					break;
				}
				case "return": {
					if (this.app) this.ipc.emit(message.id, message.value);
					break;
				}
				case "command": {
					const noHandle = () => {
						const res = {err: `Service ${this.serviceName} cannot handle commands!`};
						if (process.send) process.send({op: "return", value: {
							id: message.command.UUID,
							value: res,
							serviceName: this.serviceName
						}, UUID: message.UUID});
						console.error("I can't handle commands!");
					};
					if (this.app) {
						if (this.app.handleCommand) {
							const res = await this.app.handleCommand(message.command.msg);
							if (message.command.receptive) {
								if (process.send) process.send({op: "return", value: {
									id: message.command.UUID,
									value: res,
									serviceName: this.serviceName
								}, UUID: message.UUID});
							}
						} else {
							noHandle();
						}
					} else {
						noHandle();
					}

					break;
				}
				case "eval": {
					const errorEncountered = (err: unknown) => {
						if (message.request.receptive) {
							if (process.send) process.send({op: "return", value: {
								id: message.request.UUID,
								value: {err},
								serviceName: this.serviceName
							}, UUID: message.UUID});
						}
					};
					if (this.app) {
						this.app.runEval(message.request.stringToEvaluate)
							.then((res: unknown) => {
								if (message.request.receptive) {
									if (process.send) process.send({op: "return", value: {
										id: message.request.UUID,
										value: res,
										serviceName: this.serviceName
									}, UUID: message.UUID});
								}
							}).catch((error: unknown) => {
								errorEncountered(error);
							});
					} else {
						errorEncountered("Cluster is not ready!");
					}

					break;
				}
				case "shutdown": {
					if (this.app) {
						if (this.app.shutdown) {
							// Ask app to shutdown
							this.app.shutdown(() => {
								if (process.send) process.send({op: "shutdown"});
							});
						} else {
							if (process.send) process.send({op: "shutdown"});
						}
					} else {
						if (process.send) process.send({op: "shutdown"});
					}

					break;
				}
				case "collectStats": {
					if (process.send) process.send({op: "collectStats", stats: {
						ram: process.memoryUsage().rss / 1e6
					}});

					break;
				}
				}
			}
		});
	}
 
	private async loadCode() {
		if (this.whatToLog.includes("service_start")) console.log(`Starting service ${this.serviceName}`);

		let App = (await import(this.path));
		if (App.ServiceWorker) {
			App = App.ServiceWorker;
		} else {
			App = App.default ? App.default : App;
		}
		this.app = new App({serviceName: this.serviceName, workerID: worker.id, ipc: this.ipc});

		let ready = false;
		if (this.app) this.app.readyPromise.then(() => {
			if (this.whatToLog.includes("service_ready")) console.log(`Service ${this.serviceName} is ready!`);
			if (process.send) process.send({op: "connected"});
			ready = true;
		}).catch((err: unknown) => {
			console.error(`Service ${this.serviceName} had an error starting: ${inspect(err)}`);
			process.kill(0);
		});

		// Timeout
		if (this.timeout !== 0) {
			setTimeout(() => {
				if (!ready) {
					console.error(`Service ${this.serviceName} took too long to start.`);
					process.kill(0);
				}
			}, this.timeout);
		}

		/* this.app.admiral.on("broadcast", (m) => {
			if (!m.event) console.error(`Service ${this.serviceName} | My emit cannot be completed since the message doesn't have a "message"!`);
			if (!m.msg) m.msg = null;
			//@ts-ignore
			process.send({op: "broadcast", event: {op: m.event, msg: m.msg}});
		}) */
	}
}