$(function() {
    function WifisetupViewModel(parameters) {
        var self = this;

        self.loginState = parameters[0];
        self.settingsViewModel = parameters[1];

        self.pollingEnabled = false;
        self.pollingTimeoutId = undefined;

        self.reconnectInProgress = false;
        self.reconnectTimeout = undefined;

        self.enableQualitySorting = ko.observable(false);

        self.hostname = ko.observable();
        self.status = {
            link: ko.observable(),
            connections: {
                ap: ko.observable(),
                wifi: ko.observable(),
                wired: ko.observable()
            },
            wifi: {
                current_ssid: ko.observable(),
                current_address: ko.observable(),
                present: ko.observable()
            }
        };
        self.statusCurrentWifi = ko.observable();

        self.editorWifi = undefined;
        self.editorWifiSsid = ko.observable();
        self.editorWifiPassphrase1 = ko.observable();
        self.editorWifiPassphrase2 = ko.observable();
        self.editorWifiPassphraseMismatch = ko.computed(function() {
            return self.editorWifiPassphrase1() != self.editorWifiPassphrase2();
        });

        self.working = ko.observable(false);
        self.error = ko.observable(false);

        self.connectionStateText = ko.computed(function() {
            var text;

            if (self.error()) {
                text = gettext("Hata!");
            } else if (self.status.wifi.current_ssid()) {
                text = _.sprintf(gettext("WIFI bağlantısı mevcut. (SSID \"%(ssid)s\")"), {ssid: self.status.wifi.current_ssid()});
			} else {
                text = gettext("WIFI bağlantısı yok.");
			}
            return text;
        });

        self.daemonOnline = ko.computed(function() {
            return (!(self.error()));
        });


        // initialize list helper
        self.listHelper = new ItemListHelper(
            "wifis",
            {
                "ssid": function (a, b) {
                    // sorts ascending
                    if (a["ssid"].toLocaleLowerCase() < b["ssid"].toLocaleLowerCase()) return -1;
                    if (a["ssid"].toLocaleLowerCase() > b["ssid"].toLocaleLowerCase()) return 1;
                    return 0;
                },
                "quality": function (a, b) {
                    // sorts descending
                    if (a["quality"] > b["quality"]) return -1;
                    if (a["quality"] < b["quality"]) return 1;
                    return 0;
                }
            },
            {
            },
            "quality",
            [],
            [],
            10
        );

        self.getEntryId = function(data) {
            return "settings_plugin_wifisetup_wifi_" + md5(data.ssid);
        };

        self.refresh = function() {
            self.requestData();
        };

        self.fromResponse = function (response) {
            if (response.error !== undefined) {
                self.error(true);
                return;
            } else {
                self.error(false);
            }

            self.hostname(response.hostname);

            self.status.link(false);
            self.status.connections.ap(false);
            self.status.connections.wifi(response.status.ssid);
            self.status.connections.wired(false);
            self.status.wifi.current_ssid(response.status.ssid);
            self.status.wifi.current_address(response.status.address);
            self.status.wifi.present(response.wificheck);
			
            self.statusCurrentWifi(undefined);
            if (response.status.ssid && response.status.address) {
                _.each(response.wifis, function(wifi) {
                    if (wifi.ssid == response.status.ssid && wifi.address.toLowerCase() == response.status.address.toLowerCase()) {
                        self.statusCurrentWifi(self.getEntryId(wifi));
                    }
                });
            }

            var enableQualitySorting = false;
            _.each(response.wifis, function(wifi) {
                if (wifi.quality != undefined) {
                    enableQualitySorting = true;
                }
            });
            self.enableQualitySorting(enableQualitySorting);

            var wifis = [];
            _.each(response.wifis, function(wifi) {
                var qualityInt = parseInt(wifi.quality);
                var quality = undefined;
                if (!isNaN(qualityInt)) {
                    quality = qualityInt;
                }

                wifis.push({
                    ssid: wifi.ssid,
                    address: wifi.address,
                    encrypted: wifi.encrypted,
                    quality: quality,
                    qualityText: (quality != undefined) ? "" + quality + " dBm" : undefined
                });
            });

            self.listHelper.updateItems(wifis);
            if (!enableQualitySorting) {
                self.listHelper.changeSorting("ssid");
            }

            if (self.pollingEnabled) {
                self.pollingTimeoutId = setTimeout(function() {
                    self.requestData();
                }, 30000)
            }
        };

        self.configureWifi = function(data) {
            //if (!self.loginState.isAdmin()) return;
			
            self.editorWifi = data;
            self.editorWifiSsid(data.ssid);
            self.editorWifiPassphrase1(undefined);
            self.editorWifiPassphrase2(undefined);
            if (data.encrypted) {
                $("#settings_plugin_wifisetup_wificonfig").modal("show");
            } else {
                self.confirmWifiConfiguration();
            }
        };

        self.confirmWifiConfiguration = function() {
            self.sendWifiConfig(self.editorWifiSsid(), self.editorWifiPassphrase1(), function() {
                self.editorWifi = undefined;
                self.editorWifiSsid(undefined);
                self.editorWifiPassphrase1(undefined);
                self.editorWifiPassphrase2(undefined);
                $("#settings_plugin_wifisetup_wificonfig").modal("hide");
            });
        };

        self.sendWifiRefresh = function(force) {
            if (force === undefined) force = false;
            self._postCommand("list_wifi", {force: force}, function(response) {
                self.fromResponse({"wifis": response});
            });
        };

        self.sendWifiConfig = function(ssid, psk, successCallback, failureCallback) {
            //if (!self.loginState.isAdmin()) return;
			
            self.working(true);
            if (self.status.connections.ap()) {
                self.reconnectInProgress = true;

                var reconnectText = gettext("OctoPrint is now switching to your configured Wifi connection and therefore shutting down the Access Point. I'm continuously trying to reach it at <strong>%(hostname)s</strong> but it might take a while. If you are not reconnected over the next couple of minutes, please try to reconnect to OctoPrint manually because then I was unable to find it myself.");

                showOfflineOverlay(
                    gettext("Reconnecting..."),
                    _.sprintf(reconnectText, {hostname: self.hostname()}),
                    self.tryReconnect
                );
            }
            self._postCommand("configure_wifi", {ssid: ssid, psk: psk}, successCallback, failureCallback, function() {
                self.working(false);
                if (self.reconnectInProgress) {
                    self.tryReconnect();
                }
            }, 5000);
        };

        self.sendForgetWifi = function() {
            //if (!self.loginState.isAdmin()) return;
            self._postCommand("forget_wifi", {});
        };

        self.tryReconnect = function() {
            var hostname = self.hostname();

            var location = window.location.href
            location = location.replace(location.match("https?\\://([^:@]+(:[^@]+)?@)?([^:/]+)")[3], hostname);

            var pingCallback = function(result) {
                if (!result) {
                    return;
                }

                if (self.reconnectTimeout != undefined) {
                    clearTimeout(self.reconnectTimeout);
                    window.location.replace(location);
                }
                hideOfflineOverlay();
                self.reconnectInProgress = false;
            };

            ping(location, pingCallback);
            self.reconnectTimeout = setTimeout(self.tryReconnect, 1000);
        };

        self._postCommand = function (command, data, successCallback, failureCallback, alwaysCallback, timeout) {
            var payload = _.extend(data, {command: command});

            var params = {
                url: API_BASEURL + "plugin/wifisetup",
                type: "POST",
                dataType: "json",
                data: JSON.stringify(payload),
                contentType: "application/json; charset=UTF-8",
                success: function(response) {
                    if (successCallback) successCallback(response);
                },
                error: function() {
                    if (failureCallback) failureCallback();
                },
                complete: function() {
                    if (alwaysCallback) alwaysCallback();
                }
            };

            if (timeout != undefined) {
                params.timeout = timeout;
            }

            $.ajax(params);
        };

        self.requestData = function () {
            if (self.pollingTimeoutId != undefined) {
                clearTimeout(self.pollingTimeoutId);
                self.pollingTimeoutId = undefined;
            }
			
            $.ajax({
                url: API_BASEURL + "plugin/wifisetup",
                type: "GET",
                dataType: "json",
                success: self.fromResponse
            });
        };

        self.onUserLoggedIn = function(user) {
            //if (user.admin) {
                self.requestData();
           // }
        };

        self.onBeforeBinding = function() {
            self.settings = self.settingsViewModel.settings;
        };

        self.onSettingsShown = function() {
            self.pollingEnabled = true;
            self.requestData();
        };

        self.onSettingsHidden = function() {
            if (self.pollingTimeoutId != undefined) {
                self.pollingTimeoutId = undefined;
            }
            self.pollingEnabled = false;
        };

        self.onServerDisconnect = function() {
            return !self.reconnectInProgress;
        }

    }

    // view model class, parameters for constructor, container to bind to
    OCTOPRINT_VIEWMODELS.push({
        construct: WifisetupViewModel,
        dependencies: ["loginStateViewModel", "settingsViewModel"],
        elements: ["#settings_plugin_wifisetup", "#tab_plugin_wifisetup"]
    });
});
