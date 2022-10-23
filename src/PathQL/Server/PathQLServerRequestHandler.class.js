import {PathQLNotExistsError} from "pathql/src/PathQL/Error/PathQLNotExistsError.class.js";

export class PathQLServerRequestHandler {

	constructor(options = {}) {
		this.port = options.port ? options.port : 9080;
		this.host = options.host ? options.host : "localhost";
		this.name = options.name ? options.name : "PathQLServerRequestHandler";
		this.version = options.version ? options.version : "0.1";
		this.db = options.db ? options.db : null;
		this.clients = {};
		this.debug = true;
		this.run = false;
		this.objects = {};
		this.objectCache = {};
		if(!this.db) {
			throw new PathQLNotExistsError({msg: "database not given!"});
		}
	}

	async listen() {
		console.log(`${this.name} v${this.version} listen...`);
		if(this.cert && this.key) {
			this.listener = await Deno.listenTls({port: this.port, hostname: this.host, certFile: this.cert, keyFile: this.key});
		}else {
			this.listener = await Deno.listen({port: this.port, hostname: this.host});
		}
		this.run = true;
		
		while(this.run) {
			this.handleConnection(await this.listener.accept());
		}
	}

	async handleConnection(tcpConnection) {
		const httpConnection = Deno.serveHttp(tcpConnection);
		while(this.run) {
			const connection = await httpConnection.nextRequest();
			if(connection) {
				const {socket, response} = Deno.upgradeWebSocket(connection.request);

				socket.hasPermission = function(permission) {
					if(socket.client) {
						return socket.client.hasPermission(permission);
					}
					return true;
				}

				socket.permissions = ["*"];

				socket.broadcast = function(msg) {
					for(const client in this.clients) {
						msg.time = Date.now();
						this.clients[client].send(JSON.stringify(
							msg
						));
					}
				}.bind(this)

				socket.addEventListener("open", function(e) {
					e.currentTarget.id = tcpConnection.rid;
					this.clients[e.currentTarget.id] = socket;
					socket.edits = {};
				}.bind(this));

				socket.addEventListener("message", async function(e) {
					try {
						const msg = JSON.parse(e.data);
						if(msg.pathql != null) {
							const answer = {};
							for(const objName in msg.pathql) {
								if(this.objects[objName] != null) {
									try {
										msg.pathql[objName].data = msg.pathql[objName].data ? msg.pathql[objName].data : {};
										if(msg.pathql[objName].token != null && msg.pathql[objName].token != "") {
											if(this.objectCache[msg.pathql[objName].token] != null) {
												answer[objName] = await this.objectCache[msg.pathql[objName].token].parseRequest({
													data: msg.pathql[objName],
													settings: {
														connection: socket
													}
												});
												continue;
											}
										}
										const obj = await new this.objects[objName]({db: this.db});
										answer[objName] = await obj.parseRequest({
											data: msg.pathql[objName],
											settings: {
												connection: socket
											}
										});
										if(obj.token != null && obj.token != "") {
											this.objectCache[obj.token] = obj;
											this.objectCache[obj.token].addEventListener("run", function(e) {
												const data = e.detail;
												for(const id in this.clients) {
													const client = this.clients[id];
													if(client.hasPermission(`${objName}.${data.permission}`)) {
														data.obj = objName;
														data.token = obj.token;
														const response = {
															event: data,
															time: Date.now()
														}
														client.send(JSON.stringify(
															response
														));
													}
												}
											}.bind(this));
										}
									} catch (e) {
										console.error(e);
										if(typeof(e.toJSON) == "function") {
											answer[objName] = {
												error: e.toJSON()
											}
										}else {
											answer[objName] = {
												error: e
											}
										}
									}
								}else {
									answer[objName] = {
										error: {
											msg: "Object type not exists!"
										}
									}
								}
							}

							if(msg.messageCounter != undefined) {
								answer["messageCounter"] = msg.messageCounter;
							}

							answer.time = Date.now();
							socket.send(JSON.stringify(answer));
						}else if(msg.ping) {
							socket.send(JSON.stringify({
								pong: Date.now()
							}));
						}else if(msg.getObject) {
							const answer = {};
							const object = await this.getObject(msg.getObject);
							if(object) {
								answer[msg.getObject] = object;
							}else {
								answer[msg.getObject] = {
									error: {
										msg: "Object not exists!"
									}
								}
							}
							if(msg.messageCounter != undefined) {
								answer["messageCounter"] = msg.messageCounter;
							}
							answer.time = Date.now();
							socket.send(JSON.stringify(answer));
						}else if(msg.getAllObjects) {
							const answer = {};
							answer.objects = {};
							for(const objectName in this.objects) {
								const object = await this.getObject(objectName);
								if(object) {
									answer.objects[objectName] = object;
								}else {
									answer.objects[objectName] = {
										error: {
											msg: "Object not exists!"
										}
									}
								}
							}
							if(msg.messageCounter != undefined) {
								answer["messageCounter"] = msg.messageCounter;
							}

							answer.time = Date.now();
							socket.send(JSON.stringify(answer));
						}
					} catch (err) {
						console.log(err);
						this.addClientError(e.target, err);
					}
				}.bind(this));

				socket.addEventListener("close", async function(e) {
						for(const token in socket.edits) {
							try {
								await this.objectCache[token].unlockKey(socket.edits[token], {settings: {connection: socket}});
							}catch(_e) {
								console.log(`Unlock the object cache of ${token} failed.`);
							}
						}
						delete(this.clients[e.target.id]);
				}.bind(this));

				socket.addEventListener("error", function(e) {
					this.addClientError(socket, e);
				}.bind(this));

				connection.respondWith(response);
			}
		}
	}

	stop() {
		this.run = false;
		if(this.listener) {
			this.listener.close();
		}
	}

	async getObject(objectName) {
		if(this.objects[objectName] != null) {
			const object = await new this.objects[objectName]({db: this.db});
			const fieldArray = {};
			for(const key in object.fields) {
				// TODO: check the user permission
				if(!object.fields[key].private) {
					fieldArray[key] = object.fields[key];
				}
			}

			const methodArray = {};
			for(const key in object.methods) {
				// TODO: check the user permission
				methodArray[key] = object.methods[key];
			}

			const objectArray = {};
			for(const key in object.objects) {
				// TODO: check the user permission
				objectArray[key] = JSON.stringify(object.objects[key]);
			}

			return {
				fields: fieldArray,
				objects: objectArray,
				methods: methodArray
			};
		}else {
			return null;
		}
	}

	/**
	 * Add error to client socket
	 * @param {Socket} socket 
	 * @param {Error} e 
	 */
	addClientError(socket, e) {
    if(this.debug) {
      console.error(e);
    }
    socket.error = socket.error += e.message;
  }
}
