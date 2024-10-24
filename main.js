'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const qs = require('qs');
const WebSocket = require('ws');
const crypto = require('crypto');
const Json2iob = require('./lib/json2iob');
const https = require('https');

class Teslamotors extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'tesla-motors',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.session = {};
    this.tempTokens = {}; // Temporäre Tokens
    this.sleepTimes = {};
    this.lastStates = {};
    this.updateIntervalDrive = {};
    this.idArray = [];
    this.retryAfter = {}; // Retry-After Zeit für jedes Fahrzeug
    this.minInterval = 432000; // Minimum Intervall in Millisekunden
    this.json2iob = new Json2iob(this);
    this.vin2id = {};
    this.id2vin = {};

    this.requestClient = axios.create();
  }

  async onReady() {
    this.setState('info.connection', false, true);
    if (this.config.intervalNormal < 432) {
        this.log.info('Set interval to minimum 423 seconds');
        this.config.intervalNormal = 432;
    }
    this.adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
    const obj = await this.getForeignObjectAsync(this.adapterConfig);
    if (this.config.reset) {
        if (obj) {
            obj.native.session = {};
            obj.native.cookies = '';
            obj.native.captchaSvg = '';
            obj.native.reset = false;
            obj.native.captcha = '';
            obj.native.codeUrl = '';
            obj.native.partnerAuthToken = '';
            obj.native.refreshToken = '';
            obj.native.accessToken = '';
            obj.native.vehicleId = '';
            obj.native.id = '';
            obj.native.clientId = '';
            obj.native.clientSecret = '';
            obj.native.domain = '';
            obj.native.region = '';
            obj.native.redirectUri = '';
            obj.native.teslaApiProxyUrl = '';
            await this.setForeignObjectAsync(this.adapterConfig, obj);
            this.log.info('Login Token resetted');
            this.terminate();
        }
    }

    if (obj && obj.native.session && obj.native.session.refreshToken) {
        this.session = obj.native.session;
        this.log.info('Session loaded');
        this.log.info('Refresh session');
        this.session.refresh_token = this.config.refreshToken;
        await this.refreshToken(true);
    } else if (this.config.refreshToken) {
        this.session.refresh_token = this.config.refreshToken; // Lade den Token aus der Konfiguration
        this.log.info('Initial session setup with config token');
        await this.refreshToken(true);
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;

    this.subscribeStates('*');
    this.headers = {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'x-tesla-user-agent': 'TeslaApp/4.7.0-910/fde17d58a/ios/14.8',
        'user-agent': 'Tesla/4.7.0 (com.teslamotors.TeslaApp; build:910; iOS 14.8.0) Alamofire/5.2.1',
        'accept-language': 'de-de',
    };
    if (!this.config.useNewApi && !this.session.access_token) {
        this.log.info('Initial login');
        await this.login();
    }
    if (this.config.useNewApi) {
        this.session.access_token = this.config.accessToken;
    }
    if (this.session.access_token) {
        this.log.info('Receive device list');
        await this.getDeviceList();
        this.updateDevices();
        this.updateInterval = setInterval(async () => {
            await this.updateDevices();
        }, this.config.intervalNormal * 1000);
        if (this.config.locationInterval > 10) {
            this.updateDevices(false, true);
            this.locationInterval = setInterval(async () => {
                await this.updateDevices(false, true);
            }, this.config.locationInterval * 1000);
        } else {
            this.log.info('Location interval is less than 10s. Skip location update');
        }
        if (!this.config.useNewApi) {
            const intervalTime = this.session.expires_in ? (this.session.expires_in - 200) * 1000 : 3000 * 1000;
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, intervalTime);
        }
    }
}

  async login() {
    if (!this.config.codeUrl) {
      this.log.info('Waiting for codeURL please visit instance settings and copy url after login');
      return;
    }

    const code_verifier = '82326a2311262e580d179dc5023f3a7fd9bc3c9e0049f83138596b66c34fcdc7';
    let code = '';
    try {
      const queryParams = qs.parse(this.config.codeUrl.split('?')[1]);
      code = queryParams.code;
    } catch (error) {
      this.log.error(error);
      this.log.error('Invalid codeURL please visit instance settings and copy url after login');
      return;
    }

    const data = {
      grant_type: 'authorization_code',
      code: code,
      client_id: 'ownerapi',
      redirect_uri: 'https://auth.tesla.com/void/callback',
      scope: 'openid email offline_access',
      code_verifier: code_verifier,
    };
    this.log.debug(JSON.stringify(data));
    await this.requestClient({
      method: 'post',
      url: 'https://auth.tesla.com/oauth2/v3/token',
      headers: this.headers,
      data: qs.stringify(data),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;

        this.log.info('Login successful');
        this.setState('info.connection', true, true);
        return res.data;
      })
      .catch(async (error) => {
        this.setState('info.connection', false, true);
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        if (error.response && error.response.status === 403) {
          this.log.error('Please relogin in the settings and copy a new codeURL');
          const obj = await this.getForeignObjectAsync(this.adapterConfig);
          if (obj) {
            obj.native.codeUrl = '';
            this.setForeignObject(this.adapterConfig, obj);
          }
        }
      });
  }

  async getDeviceList() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': 'ioBroker 1.1.0',
      Authorization: 'Bearer ' + this.session.access_token,
    };

    const apiUrl = this.config.useNewApi
      ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles'
      : 'https://owner-api.teslamotors.com/api/1/products?orders=1';

    await this.requestClient({
      method: 'get',
      url: apiUrl,
      headers: headers,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        this.idArray = [];
        this.log.info(`Found ${res.data.response.length} devices`);
        for (const device of res.data.response) {
          const id = device.vin || device.id;
          if (!device.id) {
            this.log.info('No ID found for device ' + JSON.stringify(device));
            continue;
          }
          const exlucdeList = this.config.excludeDeviceList.replace(/\s/g, '').split(',');
          if (exlucdeList.includes(id)) {
            this.log.info('Skip device ' + id);
            continue;
          }
          this.log.info(`Found device ${id} from type ${device.vehicle_id ? 'vehicle' : device.resource_type}`);
          const deviceId = device.id_s || device.id;
          this.vin2id[id] = deviceId;
          this.id2vin[deviceId] = id;
          this.log.debug(id);
          if (device.vehicle_id) {
            this.idArray.push({ id: this.vin2id[id], type: 'vehicle', vehicle_id: device.vehicle_id, vin: id });
          } else {
            if (!device.energy_site_id) {
              this.log.warn('No energy_site_id found for device ' + JSON.stringify(device));
              continue;
            }
            this.idArray.push({
              id: this.vin2id[id],
              type: device.resource_type || 'unknown',
              energy_site_id: device.energy_site_id,
            });
          }
          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: device.display_name || device.site_name || device.resource_type,
            },
            native: {},
          });

          this.json2iob.parse(id, device);

          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });

          let remoteArray = [
            { command: 'force_update' },
            { command: 'wake_up' },
            { command: 'honk_horn' },
            { command: 'flash_lights' },
            { command: 'remote_start_drive' },
            { command: 'trigger_homelink' },
            { command: 'set_sentry_mode' },
            { command: 'door_unlock' },
            { command: 'door_lock' },
            { command: 'actuate_trunk-rear' },
            { command: 'actuate_trunk-front' },
            { command: 'window_control-vent' },
            { command: 'window_control-close' },
            { command: 'sun_roof_control-vent' },
            { command: 'sun_roof_control-close' },
            { command: 'charge_port_door_open' },
            { command: 'charge_port_door_close' },
            { command: 'charge_start' },
            { command: 'charge_stop' },
            { command: 'charge_standard' },
            { command: 'charge_max_range' },
            { command: 'set_charge_limit', type: 'number', role: 'level' },
            { command: 'set_temps-driver_temp', type: 'number', role: 'level' },
            { command: 'set_temps-passenger_temp', type: 'number', role: 'level' },
            { command: 'set_bioweapon_mode' },
            {
              command: 'set_scheduled_charging',
              name: 'Number of minutes from midnight in intervals of 15',
              type: 'json',
              role: 'state',
            },
            { command: 'set_scheduled_departure', name: 'Change default json to modify', type: 'json', role: 'state' },
            { command: 'set_charging_amps-charging_amps', type: 'number', role: 'level' },
            { command: 'remote_seat_heater_request-0', type: 'number', role: 'level' },
            { command: 'remote_seat_heater_request-1', type: 'number', role: 'level' },
            { command: 'remote_seat_heater_request-2', type: 'number', role: 'level' },
            { command: 'remote_seat_heater_request-3', type: 'number', role: 'level' },
            { command: 'remote_seat_heater_request-4', type: 'number', role: 'level' },
            { command: 'remote_seat_heater_request-5', type: 'number', role: 'level' },
            { command: 'schedule_software_update-offset_sec', type: 'number', role: 'level' },
            { command: 'auto_conditioning_start' },
            { command: 'auto_conditioning_stop' },
            { command: 'media_toggle_playback' },
            { command: 'media_next_track' },
            { command: 'media_prev_track' },
            { command: 'media_volume_up' },
            { command: 'media_volume_down' },
            { command: 'set_preconditioning_max' },
            { command: 'share', type: 'string', role: 'text' },
            { command: 'remote_steering_wheel_heater_request' },
          ];
          if (!device.vehicle_id) {
            remoteArray = [
              { command: 'backup-backup_reserve_percent', type: 'number', role: 'level' },
              { command: 'operation-self_consumption' },
              { command: 'operation-backup' },
              {
                command: 'off_grid_vehicle_charging_reserve-off_grid_vehicle_charging_reserve_percent',
                type: 'number',
                role: 'level',
              },
            ];
          }
          remoteArray.forEach(async (remote) => {
            await this.setObjectNotExistsAsync(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'button',
                write: true,
                read: true,
              },
              native: {},
            });
            if (remote.command === 'set_scheduled_departure') {
              this.setState(
                id + '.remote.' + remote.command,
                `{
                  "departure_time": 375,
                  "preconditioning_weekdays_only": false,
                  "enable": true,
                  "off_peak_charging_enabled": true,
                  "preconditioning_enabled": false,
                  "end_off_peak_time": 420,
                  "off_peak_charging_weekdays_only": true
                }`,
                true,
              );
            }
            if (remote.command === 'set_scheduled_charging') {
              this.setState(
                id + '.remote.' + remote.command,
                `{
                  "time": 0,
                  "enable": true
                }`,
                true,
              );
            }
          });
          this.delObjectAsync(
            this.name + '.' + this.instance + '.' + id + '.remote.set_scheduled_charging-scheduled_charging',
          );
          this.delObjectAsync(
            this.name + '.' + this.instance + '.' + id + '.remote.set_scheduled_departure-scheduled_departure',
          );
          this.delObject(id + '.tokens', { recursive: true });
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices(forceUpdate, location = false) {
    let vehicleStatusArray = [
        {
            path: '',
            url: this.config.useNewApi
                ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/{id}/vehicle_data'
                : 'https://owner-api.teslamotors.com/api/1/vehicles/{id}/vehicle_data',
        },
        {
            path: '.charge_history',
            url: this.config.useNewApi
                ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/dx/charging/history'
                : 'https://owner-api.teslamotors.com/api/1/vehicles/{id}/charge_history?vehicle_trim=5&client_time_zone=Europe/Berlin&client_country=DE&currency_code=EUR&state=&time_zone=Europe/Vatican&state_label=&vehicle_model=2&language=de&country_label=Deutschland&country=DE',
            method: this.config.useNewApi ? 'GET' : 'POST',
        },
    ];

    if (location) {
        vehicleStatusArray = [
            {
                path: '',
                url: this.config.useNewApi
                    ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/{id}/vehicle_data?endpoints=location_data'
                    : 'https://owner-api.teslamotors.com/api/1/vehicles/{id}/vehicle_data?endpoints=location_data',
            },
        ];
    }

    const powerwallArray = [
        { path: '', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/site_status' },
        { path: '', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/site_info' },
        { path: '.live_status', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/live_status' },
        { path: '.backup_history', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/history?kind=backup' },
        { path: '.energy_history', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/calendar_history?kind=energy&period=day&time_zone=Europe%2FBerlin' },
        { path: '.self_consumption_history', url: `https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/calendar_history?kind=self_consumption&period=day&start_date=2016-01-01T00%3A00%3A00%2B01%3A00&time_zone=Europe%2FBerlin&end_date=${this.getDate()}` },
        { path: '.self_consumption_history_lifetime', url: `https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/calendar_history?kind=self_consumption&period=lifetime&time_zone=Europe%2FBerlin&end_date=${this.getDate()}` },
        { path: '.energy_history_lifetime', url: `https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/calendar_history?kind=energy&time_zone=Europe/Berlin&period=lifetime&end_date=${this.getDate()}` },
    ];

    const wallboxArray = [
        { path: '', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/site_info' },
        { path: '.live_status', url: 'https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/live_status' },
        { path: '.telemetry_history', url: `https://owner-api.teslamotors.com/api/1/energy_sites/{energy_site_id}/telemetry_history?period=month&time_zone=Europe%2FBerlin&kind=charge&start_date=2016-01-01T00%3A00%3A00%2B01%3A00&end_date=${this.getDate()}` },
    ];

    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: '*/*',
        Authorization: 'Bearer ' + this.session.access_token,
    };

    for (const product of this.idArray) {
        const id = product.id;
        let currentArray;
        const energy_site_id = product.energy_site_id;
        if (product.type === 'vehicle') {
            let state = await this.checkState(id);
            this.log.debug(id + ': ' + state);
            if (state === 'asleep' && !this.config.wakeup) {
                this.log.debug(id + ' asleep skip update');
                this.lastStates[id] = state;
                continue;
            }
            let waitForSleep = false;
            if (this.lastStates[id] && this.lastStates[id] !== 'asleep' && forceUpdate !== true) {
                waitForSleep = await this.checkWaitForSleepState(product.vin);
            } else {
                if (forceUpdate) {
                    this.log.debug('Skip wait because force update');
                } else {
                    this.log.debug('Skip wait because last state was asleep');
                }
            }
            this.lastStates[id] = state;

            if (waitForSleep && !this.config.wakeup) {
                if (!this.sleepTimes[id]) {
                    this.sleepTimes[id] = Date.now();
                    if (this.ws) {
                        this.ws.close();
                    }
                }
                if (Date.now() - this.sleepTimes[id] >= 900000) {
                    this.log.debug(id + ' wait for sleep was not successful');
                    this.sleepTimes[id] = null;
                } else {
                    this.log.debug(id + ' skip update. Waiting for sleep');
                    continue;
                }
            }

            if (this.config.wakeup && state !== 'online') {
                while (state !== 'online') {
                    let errorButNotTimeout = false;

                    const vehicleState = await this.sendCommand(id, 'wake_up').catch((error) => {
                        if (error.response && error.response.status !== 408 && error.response.status !== 503) {
                            errorButNotTimeout = true;
                        }
                    });
                    if (errorButNotTimeout || !vehicleState) {
                        break;
                    }
                    state = vehicleState.state;
                    await this.sleep(10000);
                }
            }
            currentArray = vehicleStatusArray;

            if (this.config.streaming) {
                this.connectToWS(product.vehicle_id, product.id);
            }
        } else if (product.type === 'wall_connector') {
            currentArray = wallboxArray;
        } else {
            currentArray = powerwallArray;
        }
        this.log.debug(`Update ${id} with array: ${JSON.stringify(currentArray)}`);
        for (const element of currentArray) {
            const exlucdeList = this.config.excludeElementList.replace(/\s/g, '').split(',');
            if (element.path && exlucdeList.includes(element.path.replace('.', ''))) {
                this.log.info('Skip path ' + element.path);
                continue;
            }
            let url = element.url.replace('{id}', id);
            url = url.replace('{energy_site_id}', energy_site_id);
            this.log.debug(url);

            if (element.path === '.charge_history') {
                const diff = 60 * 60 * 1000;
                if (!this.lastChargeHistory || Date.now() - this.lastChargeHistory > diff) {
                    this.lastChargeHistory = Date.now();
                } else {
                    this.log.debug('Skip charge history because last update was less than 1h ago');
                    continue;
                }
            }

            // Check if rate limit applies
            if (this.retryAfter[id] && Date.now() < this.retryAfter[id]) {
                this.log.debug(`Skip update for ${id} due to rate limit. Retry after ${new Date(this.retryAfter[id]).toLocaleTimeString()}`);
                continue;
            }

            await this.requestClient({
                method: element.method || 'GET',
                url: url,
                headers: headers,
                params: this.config.useNewApi
                    ? {
                        vin: this.id2vin[id],
                        sortOrder: 'ASC',
                    }
                    : {},
            })
                .then((res) => {
                    this.log.debug(JSON.stringify(res.data));

                    if (!res.data) {
                        return;
                    }
                    if (res.data.response && res.data.response.tokens) {
                        delete res.data.response.tokens;
                    }
                    const data = res.data.response;
                    let preferedArrayName = 'timestamp';
                    let forceIndex = false;
                    if (element.path === '.charge_history') {
                        preferedArrayName = 'title';
                        if (data && data.charging_history_graph) {
                            delete data.charging_history_graph.y_labels;
                            delete data.charging_history_graph.x_labels;
                        }
                        if (data && data.gas_savings) {
                            delete data.gas_savings.card;
                        }
                        if (data && data.energy_cost_breakdown) {
                            delete data.energy_cost_breakdown.card;
                        }
                        if (data && data.charging_tips) {
                            delete data.charging_tips;
                        }
                    }
                    if (element.path.includes('lifetime')) {
                        for (const serie of data.time_series) {
                            if (!data.total) {
                                data.total = JSON.parse(JSON.stringify(serie));
                            } else {
                                for (const key in serie) {
                                    if (typeof serie[key] === 'number') {
                                        data.total[key] += serie[key];
                                    } else {
                                        data.total[key] = serie[key];
                                    }
                                }
                            }
                        }
                    }
                    if (element.path.includes('energy_history')) {
                        const totals = {};
                        for (const serie of data.time_series) {
                            let date = serie.timestamp.split('T')[0];
                            if (element.path.includes('lifetime')) {
                                date = serie.timestamp.slice(0, 4);
                            }
                            if (!totals[date]) {
                                totals[date] = JSON.parse(JSON.stringify(serie));
                            } else {
                                for (const key in serie) {
                                    if (typeof serie[key] === 'number') {
                                        totals[date][key] += serie[key];
                                    } else {
                                        totals[date][key] = serie[key];
                                    }
                                }
                            }
                        }
                        const totalArray = [];
                        for (const key in totals) {
                            totalArray.push(totals[key]);
                        }
                        data.time_series = totalArray;
                    }
                    if (element.path.includes('history')) {
                        forceIndex = true;
                    }

                    this.json2iob.parse(this.id2vin[id] + element.path, data, {
                        preferedArrayName: preferedArrayName,
                        forceIndex: forceIndex,
                    });
                    if (data && data.drive_state) {
                        if (data.drive_state.shift_state && this.config.intervalDrive > 0) {
                            if (!this.updateIntervalDrive[id]) {
                                this.updateIntervalDrive[id] = setInterval(async () => {
                                    this.updateDrive(id);
                                }, this.config.intervalDrive * 1000);
                            }
                        } else {
                            if (this.updateIntervalDrive[id]) {
                                clearInterval(this.updateIntervalDrive[id]);
                                this.updateIntervalDrive[id] = null;
                            }
                        }
                    }
                })
                .catch(async (error) => {
                    if (error.response && error.response.status === 401) {
                        error.response && this.log.error(JSON.stringify(error.response.data));
                        this.log.info(element.path + ' receive 401 error. Refresh Token');
                        await this.refreshToken();

                        // Retry the request after refreshing the token
                        await this.requestClient({
                            method: element.method || 'GET',
                            url: url,
                            headers: {
                                ...headers,
                                Authorization: 'Bearer ' + this.session.access_token,
                            },
                            params: this.config.useNewApi
                                ? {
                                    vin: this.id2vin[id],
                                    sortOrder: 'ASC',
                                }
                                : {},
                        }).then((res) => {
                            this.log.debug(JSON.stringify(res.data));

                            if (!res.data) {
                                return;
                            }
                            if (res.data.response && res.data.response.tokens) {
                                delete res.data.response.tokens;
                            }
                            const data = res.data.response;
                            let preferedArrayName = 'timestamp';
                            let forceIndex = false;
                            if (element.path === '.charge_history') {
                                preferedArrayName = 'title';
                                if (data && data.charging_history_graph) {
                                    delete data.charging_history_graph.y_labels;
                                    delete data.charging_history_graph.x_labels;
                                }
                                if (data && data.gas_savings) {
                                    delete data.gas_savings.card;
                                }
                                if (data && data.energy_cost_breakdown) {
                                    delete data.energy_cost_breakdown.card;
                                }
                                if (data && data.charging_tips) {
                                    delete data.charging_tips;
                                }
                            }
                            if (element.path.includes('lifetime')) {
                                for (const serie of data.time_series) {
                                    if (!data.total) {
                                        data.total = JSON.parse(JSON.stringify(serie));
                                    } else {
                                        for (const key in serie) {
                                            if (typeof serie[key] === 'number') {
                                                data.total[key] += serie[key];
                                            } else {
                                                data.total[key] = serie[key];
                                            }
                                        }
                                    }
                                }
                            }
                            if (element.path.includes('energy_history')) {
                                const totals = {};
                                for (const serie of data.time_series) {
                                    let date = serie.timestamp.split('T')[0];
                                    if (element.path.includes('lifetime')) {
                                        date = serie.timestamp.slice(0, 4);
                                    }
                                    if (!totals[date]) {
                                        totals[date] = JSON.parse(JSON.stringify(serie));
                                    } else {
                                        for (const key in serie) {
                                            if (typeof serie[key] === 'number') {
                                                totals[date][key] += serie[key];
                                            } else {
                                                totals[date][key] = serie[key];
                                            }
                                        }
                                    }
                                }
                                const totalArray = [];
                                for (const key in totals) {
                                    totalArray.push(totals[key]);
                                }
                                data.time_series = totalArray;
                            }
                            if (element.path.includes('history')) {
                                forceIndex = true;
                            }

                            this.json2iob.parse(this.id2vin[id] + element.path, data, {
                                preferedArrayName: preferedArrayName,
                                forceIndex: forceIndex,
                            });
                            if (data && data.drive_state) {
                                if (data.drive_state.shift_state && this.config.intervalDrive > 0) {
                                    if (!this.updateIntervalDrive[id]) {
                                        this.updateIntervalDrive[id] = setInterval(async () => {
                                            this.updateDrive(id);
                                        }, this.config.intervalDrive * 1000);
                                    }
                                } else {
                                    if (this.updateIntervalDrive[id]) {
                                        clearInterval(this.updateIntervalDrive[id]);
                                        this.updateIntervalDrive[id] = null;
                                    }
                                }
                            }
                        }).catch((error) => {
                            this.log.error(url);
                            this.log.error(error);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                        });

                        return;
                    }

                    if (error.response && (error.response.status >= 500 || error.response.status === 408)) {
                        this.log.debug(url);
                        this.log.debug(error);
                        error.response && this.log.debug(JSON.stringify(error.response.data));
                        return;
                    }
                    if (error.response && error.response.status === 429) {
                        const retryAfterSeconds = parseInt(error.response.headers['retry-after'], 10);
                        this.retryAfter[id] = Date.now() + retryAfterSeconds * 1000;
                        this.minInterval = Math.min(this.minInterval + 5000, retryAfterSeconds * 1000); // Erhöhe das Intervall um 5 Sekunden
                        this.log.warn(`Rate limit exceeded for ${id}. Retry after ${retryAfterSeconds} seconds. Increasing min interval to ${this.minInterval / 1000} seconds.`);
                        return;
                    }
                    this.log.error('General error');
                    this.log.error(url);
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                });
        }
    }
}

async updateDrive(id) {
  const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: '*/*',
      Authorization: 'Bearer ' + this.session.access_token,
  };

  const apiUrl = this.config.useNewApi
      ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/' + id + '/vehicle_data?endpoints=drive_state'
      : 'https://owner-api.teslamotors.com/api/1/vehicles/' + id + '/vehicle_data?endpoints=drive_state';

  await this.requestClient({
      method: 'get',
      url: apiUrl,
      headers: headers,
  })
      .then((res) => {
          this.log.debug(JSON.stringify(res.data));

          if (!res.data) {
              return;
          }
          if (res.data.response && res.data.response.tokens) {
              delete res.data.response.tokens;
          }
          const data = res.data.response;

          this.json2iob.parse(this.id2vin[id], data);
      })
      .catch(async (error) => {
          if (error.response && error.response.status === 401) {
              this.log.info('Update drive receive 401 error. Refresh Token');
              await this.refreshToken();

              // Retry the request after refreshing the token
              await this.requestClient({
                  method: 'get',
                  url: apiUrl,
                  headers: {
                      ...headers,
                      Authorization: 'Bearer ' + this.session.access_token,
                  },
              }).then((res) => {
                  this.log.debug(JSON.stringify(res.data));

                  if (!res.data) {
                      return;
                  }
                  if (res.data.response && res.data.response.tokens) {
                      delete res.data.response.tokens;
                  }
                  const data = res.data.response;

                  this.json2iob.parse(this.id2vin[id], data);
              }).catch((error) => {
                  this.log.error(apiUrl);
                  this.log.error(error);
                  error.response && this.log.error(JSON.stringify(error.response.data));
              });

              return;
          }
          if (error.response && (error.response.status >= 500 || error.response.status === 408)) {
              this.log.debug(error);
              error.response && this.log.debug(JSON.stringify(error.response.data));
              return;
          }

          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
      });
}
  
async checkState(id) {
  const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: '*/*',
      Authorization: 'Bearer ' + this.session.access_token,
  };

  const apiUrl = this.config.useNewApi
      ? 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/' + id
      : 'https://owner-api.teslamotors.com/api/1/vehicles/' + id;

  return await this.requestClient({
      method: 'get',
      url: apiUrl,
      headers: headers,
  })
      .then((res) => {
          this.log.debug(JSON.stringify(res.data));
          if (res.data.response && res.data.response.tokens) {
              delete res.data.response.tokens;
          }
          this.json2iob.parse(this.id2vin[id], res.data.response, { preferedArrayName: 'timestamp' });
          return res.data.response.state;
      })
      .catch(async (error) => {
          if (error.response && error.response.status === 401) {
              this.log.info('Check state receive 401 error. Refresh Token');
              await this.refreshToken();

              // Retry the request after refreshing the token
              return await this.requestClient({
                  method: 'get',
                  url: apiUrl,
                  headers: {
                      ...headers,
                      Authorization: 'Bearer ' + this.session.access_token,
                  },
              }).then((res) => {
                  this.log.debug(JSON.stringify(res.data));
                  if (res.data.response && res.data.response.tokens) {
                      delete res.data.response.tokens;
                  }
                  this.json2iob.parse(this.id2vin[id], res.data.response, { preferedArrayName: 'timestamp' });
                  return res.data.response.state;
              }).catch((error) => {
                  this.log.error(apiUrl);
                  this.log.error(error);
                  error.response && this.log.error(JSON.stringify(error.response.data));
              });
          }
          if (error.response && error.response.status === 404) {
              return;
          }
          if (error.response && (error.response.status >= 500 || error.response.status === 408)) {
              this.log.debug(error);
              error.response && this.log.debug(JSON.stringify(error.response.data));
              return;
          }
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
          return;
      });
}
  
async refreshToken(firstStart) {
  const apiUrl = 'https://auth.tesla.com/oauth2/v3/token';
  const data = qs.stringify({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.session.refresh_token,
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  this.log.debug("Refresh Token : " + this.session.refresh_token);

  await this.requestClient({
      method: 'post',
      url: apiUrl,
      headers: headers,
      data: data,
  })
      .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.session.access_token = res.data.access_token; // Token aktualisieren
          this.session.refresh_token = res.data.refresh_token; // Refresh-Token aktualisieren

          // Aktualisiere die gespeicherten Tokens
          this.tempTokens.accessToken = res.data.access_token;
          this.tempTokens.refreshToken = res.data.refresh_token;

          // Speichere die aktualisierten Tokens im Adapter
         /* const obj = await this.getForeignObjectAsync(this.adapterConfig);
          if (obj) {
              obj.native.session = this.session;
              obj.native.accessToken = this.tempTokens.accessToken;
              obj.native.refreshToken = this.tempTokens.refreshToken;
              await this.setForeignObjectAsync(this.adapterConfig, obj);
          }*/

          this.setState('info.connection', true, true);
          return res.data;
      })
      .catch(async (error) => {
          this.setState('info.connection', false, true);
          this.log.error('refresh token failed');
          this.log.error(error);
          if (error.code === 'ENOTFOUND') {
              this.log.error('No connection to Tesla server please check your connection');
              return;
          }
          if (error.response && error.response.status >= 400 && error.response.status < 500) {
              if (!this.config.useNewApi) {
                  this.session = {};
              }
              error.response && this.log.error(JSON.stringify(error.response.data));
              this.log.error('Start relogin in 1min');
              if (!this.config.useNewApi) {
                  this.reLoginTimeout = setTimeout(() => {
                      this.login();
                  }, 1000 * 60 * 1);
              }
          } else if (firstStart) {
              this.log.error('No connection to tesla server restart adapter in 1min');
              this.reLoginTimeout = setTimeout(() => {
                  this.restart();
              }, 1000 * 60 * 1);
          }
      });
}

  async checkWaitForSleepState(vin) {
    const shift_state = await this.getStateAsync(vin + '.drive_state.shift_state');
    const chargeState = await this.getStateAsync(vin + '.charge_state.charging_state');
  
    if (
      (shift_state && shift_state.val !== 'P' && shift_state.val !== null) ||
      (chargeState && chargeState.val && !['Disconnected', 'Complete', 'NoPower', 'Stopped'].includes(chargeState.val))
    ) {
      if (shift_state && chargeState) {
        this.log.debug(
          `Skip sleep waiting because shift state: ${shift_state.val || 'null'} or charge state: ${chargeState.val || 'null'}`,
        );
      }
      return false;
    }
  
    const checkStates = [
      '.drive_state.shift_state',
      '.drive_state.speed',
      '.climate_state.is_climate_on',
      '.charge_state.battery_level',
      '.vehicle_state.odometer',
      '.vehicle_state.locked',
      '.charge_state.charge_port_door_open',
      '.vehicle_state.df',
    ];
    for (const stateId of checkStates) {
      const curState = await this.getStateAsync(vin + stateId);
      this.log.debug('Check state: ' + vin + stateId);
      if (stateId === '.drive_state.shift_state' && curState && (curState.val === 'P' || curState.val === null)) {
        continue;
      }
  
      if (curState && (curState.ts <= Date.now() - 1800000 || curState.ts - curState.lc <= 1800000)) {
        this.log.debug(
          `Skip sleep waiting because state ${vin + stateId} changed in last 30min TS: ${new Date(
            curState.ts,
          ).toLocaleString()} LC: ${new Date(curState.lc).toLocaleString()} value: ${curState.val}`,
        );
        return false;
      }
    }
    this.log.debug('Since 30 min no changes receiving. Start waiting for sleep');
    return true;
  }
   
  async sendCommand(id, command, action, value, nonVehicle) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: '*/*',
      Authorization: 'Bearer ' + this.session.access_token,
      'x-tesla-command-protocol': '2023-10-09',
    };
  
    const apiUrlBase = this.config.useNewApi
      ? `${this.config.teslaApiProxyUrl}/api/1/vehicles/${this.id2vin[id]}`
      : `https://owner-api.teslamotors.com/api/1/vehicles/${id}`;
  
    let url = `${apiUrlBase}/command/${command}`;
  
    if (command === 'wake_up') {
      url = `${apiUrlBase}/wake_up`;
    }
    if (nonVehicle) {
      url = apiUrlBase.replace('/vehicles/', '/energy_sites/') + '/' + command;
    }
  
    const passwordArray = ['remote_start_drive'];
    const latlonArray = ['trigger_homelink', 'window_control'];
    const onArray = [
      'remote_steering_wheel_heater_request',
      'set_preconditioning_max',
      'set_sentry_mode',
      'set_bioweapon_mode',
    ];
    const valueArray = [
      'set_temps',
      'backup',
      'off_grid_vehicle_charging_reserve',
      'schedule_software_update',
      'set_charging_amps',
    ];
    const stateArray = ['sun_roof_control'];
    const commandArray = ['window_control'];
    const percentArray = ['set_charge_limit'];
    const default_real_modeArray = ['operation'];
    const heaterArray = ['remote_seat_heater_request'];
    const shareArray = ['share'];
    const trunkArray = ['actuate_trunk'];
    const plainArray = ['set_scheduled_charging', 'set_scheduled_departure'];
    let data = {};
  
    if (passwordArray.includes(command)) {
      data['password'] = this.config.password;
    }
    if (latlonArray.includes(command)) {
      const latState = await this.getStateAsync(this.id2vin[id] + '.drive_state.latitude');
      const lonState = await this.getStateAsync(this.id2vin[id] + '.drive_state.longitude');
      data['lat'] = latState ? latState.val : 0;
      data['lon'] = lonState ? lonState.val : 0;
    }
    if (onArray.includes(command)) {
      data['on'] = value;
    }
    if (valueArray.includes(command)) {
      if (command === 'set_temps') {
        const driverState = await this.getStateAsync(this.id2vin[id] + '.climate_state.driver_temp_setting');
        const passengerState = await this.getStateAsync(this.id2vin[id] + '.climate_state.passenger_temp_setting');
        data['driver_temp'] = driverState ? driverState.val : 23;
        data['passenger_temp'] = passengerState ? passengerState.val : driverState.val;
      }
      data[action] = value;
    }
    if (heaterArray.includes(command)) {
      data['heater'] = action;
      data['level'] = value;
    }
    if (stateArray.includes(command)) {
      data['state'] = action;
    }
    if (commandArray.includes(command)) {
      data['command'] = action;
    }
    if (percentArray.includes(command)) {
      data['percent'] = value;
    }
    if (default_real_modeArray.includes(command)) {
      data['default_real_mode'] = action;
    }
    if (trunkArray.includes(command)) {
      data['which_trunk'] = action;
    }
    if (shareArray.includes(command)) {
      data = {
        type: 'share_ext_content_raw',
        value: {
          'android.intent.ACTION': 'android.intent.action.SEND',
          'android.intent.TYPE': 'text/plain',
          'android.intent.extra.SUBJECT': 'Ortsname',
          'android.intent.extra.TEXT': value,
        },
        locale: 'de-DE',
        timestamp_ms: (Date.now() / 1000).toFixed(0),
      };
    }
  
    if (plainArray.includes(command)) {
      try {
        data = JSON.parse(value);
      } catch (error) {
        this.log.error(error);
      }
    }
    this.log.debug(url);
    this.log.debug(JSON.stringify(data));
    return await this.requestClient({
      method: 'post',
      url: url,
      headers: headers,
      data: data,
      timeout: 5000,
    })
      .then((res) => {
        this.log.info(JSON.stringify(res.data));
        if (res.data.response && res.data.response.tokens) {
          delete res.data.response.tokens;
        }
        return res.data.response;
      })
      .catch(async (error) => {
        if (error.response && error.response.status === 401) {
          error.response && this.log.debug(JSON.stringify(error.response.data));
          this.log.info(command + ' receive 401 error. Refresh Token');
          
          await this.refreshToken();
          
          // Retry the request after refreshing the token
          return this.requestClient({
            method: 'post',
            url: url,
            headers: {
              ...headers,
              Authorization: 'Bearer ' + this.session.access_token,
            },
            data: data,
            timeout: 5000,
          }).then((res) => {
            this.log.info(JSON.stringify(res.data));
            if (res.data.response && res.data.response.tokens) {
              delete res.data.response.tokens;
            }
            return res.data.response;
          }).catch((error) => {
            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
            throw error;
          });
          
        } else {
          this.log.error(url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
          throw error;
        }
      });
  }
  
  async connectToWS(vehicleId, id) {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = new WebSocket('wss://streaming.vn.teslamotors.com/streaming/', {
      perMessageDeflate: false,
    });
    this.wsAuthMessage = {
      msg_type: 'data:subscribe_oauth',
      token: this.session.access_token,
      value: 'speed,odometer,soc,elevation,est_heading,est_lat,est_lng,power,shift_state,range,est_range,heading',
      tag: vehicleId.toString(),
    };
    this.ws.on('open', () => {
      this.log.debug('WS open');
      this.ws.send(JSON.stringify(this.wsAuthMessage));
    });

    this.ws.on('message', (message) => {
      this.log.debug('WS received:' + message);
      try {
        const jsonMessage = JSON.parse(message);
        if (jsonMessage.msg_type === 'data:error' && !this.sleepTimes[id]) {
          this.ws.send(JSON.stringify(this.wsAuthMessage));
        }
        if (jsonMessage.msg_type === 'data:update') {
          const array = jsonMessage.value.split(',');

          const streamdata = {
            timestamp: array[0],
            speed: array[1],
            odometer: array[2],
            soc: array[3],
            elevation: array[4],
            est_heading: array[5],
            est_lat: array[6],
            est_lng: array[7],
            power: array[8],
            shift_state: array[9],
            range: array[10],
            est_range: array[11],
            heading: array[12],
          };
          this.json2iob.parse(this.id2vin[id] + '.streamData', streamdata);
        }
      } catch (error) {
        this.log.error(error);
      }
    });

    this.ws.on('error', (err) => {
      this.log.error('websocket error: ' + err);
    });
  }

  getCodeChallenge() {
    let hash = '';
    let result = '';
    const chars = '0123456789abcdef';
    result = '';
    for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    hash = crypto.createHash('sha256').update(result).digest('base64');
    hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return [result, hash];
  }

  randomString(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  extractHidden(body) {
    const returnObject = {};
    let matches;
    if (body.matchAll) {
      matches = body.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g);
    } else {
      this.log.warn(
        'The adapter needs in the future NodeJS v12. https://forum.iobroker.net/topic/22867-how-to-node-js-f%C3%BCr-iobroker-richtig-updaten',
      );
      matches = this.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g, body);
    }
    for (const match of matches) {
      returnObject[match[1]] = match[2];
    }
    return returnObject;
  }

  matchAll(re, str) {
    let match;
    const matches = [];

    while ((match = re.exec(str))) {
      matches.push(match);
    }

    return matches;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getDate() {
    return new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString();
  }

  async cleanOldObjects() {
    const driveState = await this.getObjectAsync('driveState');
    if (driveState) {
      await this.delObject('chargeState', { recursive: true });
      await this.delObject('climateState', { recursive: true });
      await this.delObject('driveState', { recursive: true });
      await this.delObject('vehicle', { recursive: true });
      await this.delObject('softwareUpdate', { recursive: true });
      await this.delObject('command', { recursive: true });
    }
  }

  async onUnload(callback) {
    try {
        this.setState('info.connection', false, true);
  
        if (this.ws) {
            this.ws.close();
        }
        Object.keys(this.updateIntervalDrive).forEach((element) => {
            clearInterval(this.updateIntervalDrive[element]);
        });
        this.updateInterval && clearInterval(this.updateInterval);
        this.refreshTimeout && clearTimeout(this.refreshTimeout);
        this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
        this.locationInterval && clearInterval(this.locationInterval);
        this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);

        // Aktualisiere gespeicherte Tokens vor dem Unload
        const obj = await this.getForeignObjectAsync(this.adapterConfig);
        if (obj) {
            obj.native.session = this.session;
            if (this.tempTokens.accessToken && this.tempTokens.refreshToken) {
              obj.native.accessToken = this.tempTokens.accessToken;
              obj.native.refreshToken = this.tempTokens.refreshToken;
          } else {
              // Wenn die temporären Tokens nicht gesetzt sind, verwenden Sie die aus der Konfiguration
              this.log.warn('Temp tokens are not set, using config tokens');
              obj.native.accessToken = this.session.access_token;
              obj.native.refreshToken = this.session.refresh_token;;
          }
            this.log.debug('Session saved');
            await this.setForeignObjectAsync(this.adapterConfig, obj);
        }

        callback();
    } catch (e) {
        callback();
    }
}
  
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        if (id.indexOf('.remote.') === -1) {
          this.log.warn('No remote command');
          return;
        }
        let productId = this.vin2id[id.split('.')[2]];

        let command = id.split('.')[4];
        const action = command.split('-')[1];
        command = command.split('-')[0];
        if (command === 'force_update') {
          this.updateDevices(true);
          this.updateDevices(true, true);
          return;
        }
        let vehicleState = await this.checkState(productId);
        let nonVehicle = false;
        if (vehicleState) {
          if (vehicleState !== 'online') {
            this.log.info('Wake up ' + id);
            while (vehicleState !== 'online') {
              let errorButNotTimeout = false;
              const vehicleStateData = await this.sendCommand(productId, 'wake_up').catch((error) => {
                if (error.response && error.response.status !== 408 && error.response.status !== 503) {
                  errorButNotTimeout = true;
                }
              });
              if (errorButNotTimeout) {
                break;
              }
              vehicleState = vehicleStateData.state;
              await this.sleep(5000);
            }
          }
        } else {
          const productIdState = await this.getStateAsync(productId + '.energy_site_id');
          if (productIdState) {
            productId = productIdState.val;
            nonVehicle = true;
          }
        }
        await this.sendCommand(productId, command, action, state.val, nonVehicle).catch(() => {});
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          await this.updateDevices(true);
        }, 5 * 1000);
      } else {
        if (id.indexOf('.remote.') !== -1) {
          return;
        }
        const resultDict = {
          driver_temp_setting: 'set_temps-driver_temp',
          charge_limit_soc: 'set_charge_limit',
          locked: 'door_lock',
          is_auto_conditioning_on: 'auto_conditioning_start',
          charge_port_door_open: 'charge_port_door_open',
          passenger_temp_setting: 'set_temps-passenger_temp',
          backup_reserve_percent: 'backup-backup_reserve_percent',
          off_grid_vehicle_charging_reserve_percent:
            'off_grid_vehicle_charging_reserve-off_grid_vehicle_charging_reserve_percent',
        };
        const idArray = id.split('.');
        const stateName = idArray[idArray.length - 1];
        const vin = id.split('.')[2];
        let value = true;
        if (resultDict[stateName] && isNaN(state.val)) {
          if (
            !state.val ||
            state.val === 'INVALID' ||
            state.val === 'NOT_CHARGING' ||
            state.val === 'ERROR' ||
            state.val === 'UNLOCKED'
          ) {
            value = false;
          }
        } else {
          value = state.val;
        }
        if (resultDict[stateName]) {
          this.log.debug('refresh remote state' + resultDict[stateName] + ' from ' + id);
          await this.setStateAsync(vin + '.remote.' + resultDict[stateName], value, true);
        }
      }
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new Teslamotors(options);
} else {
  new Teslamotors();
}
