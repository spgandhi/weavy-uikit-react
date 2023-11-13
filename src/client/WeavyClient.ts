import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import { IWeavyClient, WeavyClientOptions } from "../types/types";

export default class WeavyClient implements IWeavyClient {
  url;
  connection;
  tokenFactory;
  groups: string[] = [];
  connectionEvents: any[] = [];
  isConnectionStarted: any;
  private signalRAccessTokenRefresh = false;

  token: string = "";
  tokenPromise: Promise<string> | null;
  EVENT_NAMESPACE = ".connection";
  EVENT_CLOSE = "close";
  EVENT_RECONNECTING = "reconnecting";
  EVENT_RECONNECTED = "reconnected";

  constructor(options: WeavyClientOptions) {
    this.url = options.url;
    this.tokenFactory = options.tokenFactory;
    this.tokenPromise = null;
    this.connection = new HubConnectionBuilder()
      .configureLogging(LogLevel.None)
      .withUrl(this.url + "/hubs/rtm", {
        accessTokenFactory: async () => {
          if (this.signalRAccessTokenRefresh) {
            console.error("SignalR retrying with refreshed token.");
            const token = await this.tokenFactoryInternal(true);
            this.signalRAccessTokenRefresh = false;
            return token;
          } else {
            //console.error("first attempt")
            const token = await this.tokenFactoryInternal();
            return token;
          }
        },
      })
      .withAutomaticReconnect()
      .build();

    this.connect();

    this.connection.onclose((error) =>
      this.triggerHandler(this.EVENT_CLOSE, error)
    );
    this.connection.onreconnecting((error) =>
      this.triggerHandler(this.EVENT_RECONNECTING, error)
    );
    this.connection.onreconnected((connectionId) =>
      this.triggerHandler(this.EVENT_RECONNECTED, connectionId)
    );
  }

  async connect() {
    try {
      this.isConnectionStarted = this.connection.start();
      await this.isConnectionStarted;
    } catch (e) {
      console.log("Could not start SignalR.");
      if (!this.signalRAccessTokenRefresh) {
        this.signalRAccessTokenRefresh = true;
        this.isConnectionStarted = this.connection.start();
        await this.isConnectionStarted;
      }
    }

    this.signalRAccessTokenRefresh = false;
    console.log("SignalR connected.");
  }

  async get(url: string, retry: boolean = true): Promise<Response> {
    //const token = await this.tokenFactoryInternal();
    //console.log("GET:", url, " - t:", token);
    const response = await fetch(this.url + url, {
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer " + (await this.tokenFactoryInternal()),
      },
    });

    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && retry) {
        await this.tokenFactoryInternal(true);
        return await this.get(url, false);
      }

      console.error(`Error calling endpoint ${url}`, response);
    }

    return response;
  }

  async post(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    body: string | FormData,
    contentType: string = "application/json",
    retry: boolean = true
  ): Promise<Response> {
    let headers: HeadersInit = {
      Authorization: "Bearer " + (await this.tokenFactoryInternal()),
    };

    if (contentType !== "") {
      headers["content-type"] = contentType;
    }
    const response = await fetch(this.url + url, {
      method: method,
      body: body,
      headers: headers,
    });

    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && retry) {
        await this.tokenFactoryInternal(true);
        return await this.post(url, method, body, contentType, false);
      }

      //console.error(`Error calling endpoint ${url}`, response)
    }

    return response;
  }

  async upload(
    url: string,
    method: "POST" | "PUT" | "PATCH",
    body: string | FormData,
    contentType: string = "application/json",
    onProgress?: (progress: number) => void,
    retry: boolean = true
  ) {
    const client = this as WeavyClient;
    const token = await client.tokenFactoryInternal();

    return await new Promise<Response>(function (resolve, reject) {
      // XMLHttpRequest instead of fetch because we want to track progress
      let xhr = new XMLHttpRequest();
      xhr.open(method, client.url + url, true);
      xhr.setRequestHeader("Authorization", "Bearer " + token);
      if (contentType !== "") {
        xhr.setRequestHeader("content-type", contentType);
      }
      if (onProgress) {
        xhr.upload.addEventListener(
          "progress",
          (e: ProgressEvent<EventTarget>) => {
            onProgress((e.loaded / e.total) * 100 || 100);
          }
        );
      }

      xhr.onload = (evt: ProgressEvent<EventTarget>) => {
        if (retry && (xhr.status === 401 || xhr.status === 401)) {
          client
            .tokenFactoryInternal(true)
            .then(() =>
              client.upload(url, method, body, contentType, onProgress, false)
            )
            .then(resolve)
            .catch(reject);
        } else {
          resolve(
            new Response(xhr.response, {
              status: xhr.status,
              statusText: xhr.statusText,
            })
          );
        }
      };
      xhr.onerror = reject;
      xhr.send(body);
    });
  }

  async getToken(refresh: boolean) {
    if (!this.token || refresh) {
      this.token = await this.tokenFactory(true);
    }
    return this.token;
  }

  async tokenFactoryInternal(refresh: boolean = false): Promise<string> {
    if (this.token && !refresh) return this.token;

    if (!this.tokenPromise) {
      this.tokenPromise = this.tokenFactory(refresh);
      let token = await this.tokenPromise;

      this.tokenPromise = null;
      this.token = token;
      return this.token;
    } else {
      //console.log("Already a promise in action, wait for it to resolve...")
      return this.tokenPromise;
    }
  }

  async subscribe(group: string, event: string, callback: any) {
    await this.isConnectionStarted;

    try {
      var name = group ? group + ":" + event : event;
      await this.connection.invoke("Subscribe", name);
      this.groups.push(name);
      this.connection.on(name, callback);
    } catch (err: any) {
      console.warn("Error in Subscribe:", err);
    }
  }

  async unsubscribe(group: string, event: string, callback: any) {
    await this.isConnectionStarted;
    var name = group ? group + ":" + event : event;

    // get first occurence of group name and remove it
    const index = this.groups.findIndex((e) => e === name);
    if (index !== -1) {
      this.groups = this.groups.splice(index, 1);

      try {
        // if no more groups, remove from server
        if (!this.groups.find((e) => e === name)) {
          await this.connection.invoke("Unsubscribe", name);
        }
      } catch (err: any) {
        console.warn("Error in Unsubscribe:", err);
      }
    }

    this.connection.off(name, callback);
  }

  destroy() {
    this.connection.stop();
  }

  triggerHandler(name: string, ...data: any) {
    name = name.endsWith(this.EVENT_NAMESPACE)
      ? name
      : name + this.EVENT_NAMESPACE;
    let event = new CustomEvent(name, { cancelable: false });

    console.debug("triggerHandler", name);

    this.connectionEvents.forEach((eventHandler) => {
      if (eventHandler.name === name) {
        eventHandler.handler(event, ...data);
      }
    });

    if (name === this.EVENT_RECONNECTED + this.EVENT_NAMESPACE) {
      // re-add to signalr groups after reconnect
      for (var i = 0; i < this.groups.length; i++) {
        this.connection.invoke("Subscribe", this.groups[i]);
      }
    }
  }
}
