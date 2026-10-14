"use strict";
// @ts-check

/** @typedef {import('../../fileshare').Content} Content */
/** @typedef {import('../../fileshare').ServerInfoResult} ServerInfoResult */

/* Getting server info */

const IPandPortElement = document.getElementById('IPandPort');
const theQRCodeElement = document.getElementById('theQRCode');

let previousIpPortString = null;
/**
 * @param {Array<string>} addresses
 * @param {number} port
 */
function updateAddressInfo(addresses, port, scheme) {
    const newIpPortString = addresses.map(function (address) {
        return [address, port].join(":");
    }).join(", ");
    if (previousIpPortString != newIpPortString) {
        IPandPortElement.innerText = newIpPortString;
        if (addresses.length > 0) {
            const qrPrefix = (scheme == "https" ? "https_" : "");
            theQRCodeElement.setAttribute("src", `/qr_codes/${qrPrefix}${addresses[0]}_${port}.png`)
        } else {
            theQRCodeElement.setAttribute("src", "");
        }
        previousIpPortString = newIpPortString;
    }
}

/** @typedef {"success"|"warning"|"error"} AddressInfoStatusEnum */

/**
 * @param {AddressInfoStatusEnum} statusEnum
 */
function updateAddressInfoStatus(statusEnum) {
    if (statusEnum == "success") {
        IPandPortElement.classList.remove("error", "warning");
    } else if (statusEnum == "warning") {
        IPandPortElement.classList.remove("error");
        IPandPortElement.classList.add("warning");
    } else if (statusEnum == "error") {
        IPandPortElement.classList.remove("warning");
        IPandPortElement.classList.add("error");
    } else {
        console.error("updateAddressWError unknown statusEnum", statusEnum);
    }
}

/** @type {Object<string, boolean>} */
let _path2isCollapsed = null;
let _isCollapsedCacheTimeout = null;
const isCollapsedCache = {
    get(path) {
        if(_path2isCollapsed == null) {
            let cacheStr = null;
            try {
                cacheStr = localStorage.getItem("path2isCollapsed");
            } catch (error) {
                console.error("localStorage.getItem error", error);
            }
            if(cacheStr != null) {
                _path2isCollapsed = JSON.parse(cacheStr);
            } else {
                _path2isCollapsed = {};
            }
        }
        return _path2isCollapsed[path] == true;
    },
    set(path, isCollapsed) {
        if(isCollapsed) {
            _path2isCollapsed[path] = true;
        } else {
            // NOTE(baris): No need to store since default state is not collapsed
            delete _path2isCollapsed[path];
        }
        
        if(_isCollapsedCacheTimeout != null) clearTimeout(_isCollapsedCacheTimeout);
        
        _isCollapsedCacheTimeout = setTimeout(() => {
            let cacheStr = JSON.stringify(_path2isCollapsed)
            try {
                localStorage.setItem("path2isCollapsed", cacheStr);
            } catch (error) {
                console.error("localStorage.getItem error", error);
            }
        }, 100);
    }
}

/*
 * Files uploaded from this page and their deletion tokens.
 * NOTE: Intentionally kept only in memory (no cookie/localStorage),
 * so refreshing or closing the page gives up the right to delete them.
 */
const ownedUploads = Vue.observable({
    /** @type {Object<string, string>} -- path => token */
    path2token: {},
    /** @type {Object<string, string>} -- path => generated password, also only until refresh */
    path2password: {}
});

/**
 * @param {Array<string>} paths
 * @param {string} token
 * @param {number} expiresInMs
 */
function addOwnedUploads(paths, token, expiresInMs) {
    paths.forEach((path) => {
        Vue.set(ownedUploads.path2token, path, token);
    });
    setTimeout(() => {
        paths.forEach((path) => {
            if (ownedUploads.path2token[path] === token) {
                Vue.delete(ownedUploads.path2token, path);
            }
        });
    }, expiresInMs);
}

/* Shared clock for countdowns, corrected for server clock skew. */
const uiClock = Vue.observable({
    now: Date.now(),
    serverSkewMs: 0
});
setInterval(() => { uiClock.now = Date.now(); }, 30 * 1000);

/**
 * @param {number} totalMinutes
 * @returns {string} -- like "2d 3h", "3h 14m", "14m"
 */
function formatMinutes(totalMinutes) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
}

/*
 * Round clock with a single minute arm, one full turn is one hour.
 * Dragging past 12 o'clock adds or removes an hour.
 */
Vue.component('durationClock', {
    props: {
        value: { type: Number, required: true }, // total minutes
        maxMinutes: { type: Number, default: 30 * 24 * 60 }
    },
    data() {
        return {
            "isDragging": false,
            "ticks": Array.from({ length: 60 }, (_, i) => i),
            "presets": [[15, "15m"], [60, "1h"], [24 * 60, "1d"], [7 * 24 * 60, "7d"]]
        };
    },
    computed: {
        minuteOfHour() { return this.value % 60; },
        armAngle() { return this.minuteOfHour * 6; },
        // NOTE: Arc from 12 o'clock to the arm, shows progress within the hour.
        arcPath() {
            const m = this.minuteOfHour;
            if (m == 0) return "";
            const radians = (m * 6 - 90) * Math.PI / 180;
            const x = 100 + 84 * Math.cos(radians);
            const y = 100 + 84 * Math.sin(radians);
            return `M 100 16 A 84 84 0 ${m > 30 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
        },
        fullHours() { return Math.floor(this.value / 60); },
        days() { return Math.floor(this.value / (24 * 60)); },
        hours() { return Math.floor(this.value / 60) % 24; },
        minutes() { return this.value % 60; },
        summary() { return formatMinutes(this.value); },
        deletesAt() {
            return new Date(uiClock.now + this.value * 60 * 1000).toLocaleString([], {
                weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
            });
        }
    },
    methods: {
        setTotal(totalMinutes) {
            const clamped = Math.min(this.maxMinutes, Math.max(1, Math.round(totalMinutes)));
            // NOTE: Prop updates are async, keep the latest value for fast pointer moves.
            this.latestValue = clamped;
            if (clamped !== this.value) this.$emit("input", clamped);
        },
        /** @param {"days"|"hours"|"minutes"} unit */
        setPart(unit, rawValue) {
            const number = parseInt(rawValue, 10);
            if (isNaN(number) || number < 0) return;
            const parts = { days: this.days, hours: this.hours, minutes: this.minutes };
            parts[unit] = number;
            this.setTotal(parts.days * 24 * 60 + parts.hours * 60 + parts.minutes);
            this.$forceUpdate(); // NOTE: Re-normalizes the field even if clamped to same value.
        },
        pointerMinute(event) {
            const rect = this.$refs.face.getBoundingClientRect();
            const dx = event.clientX - (rect.left + rect.width / 2);
            const dy = event.clientY - (rect.top + rect.height / 2);
            const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
            return Math.round(degrees / 6) % 60;
        },
        moveArmTo(event) {
            // NOTE: Takes the shortest way around, so crossing 12 o'clock carries the hour.
            const current = this.latestValue;
            let delta = this.pointerMinute(event) - (current % 60);
            if (delta > 30) delta -= 60;
            if (delta < -30) delta += 60;
            this.setTotal(current + delta);
        },
        onPointerDown(event) {
            this.isDragging = true;
            this.latestValue = this.value;
            try {
                this.$refs.face.setPointerCapture(event.pointerId);
            } catch (error) {
                // NOTE: Dragging still works without capture, just not outside the clock.
            }
            this.moveArmTo(event);
        },
        onPointerMove(event) {
            if (this.isDragging) this.moveArmTo(event);
        },
        onPointerUp(event) {
            this.isDragging = false;
            if (this.$refs.face.hasPointerCapture(event.pointerId)) {
                this.$refs.face.releasePointerCapture(event.pointerId);
            }
        },
        onKeyDown(event) {
            const step = event.shiftKey ? 60 : 1;
            this.latestValue = this.value;
            if (event.key == "ArrowUp" || event.key == "ArrowRight") this.setTotal(this.value + step);
            else if (event.key == "ArrowDown" || event.key == "ArrowLeft") this.setTotal(this.value - step);
            else return;
            event.preventDefault();
        }
    },
    template: `<div class="duration-clock">
        <svg
            ref="face"
            class="clock-face noselect"
            :class="{'dragging': isDragging}"
            viewBox="0 0 200 200"
            role="slider"
            tabindex="0"
            aria-label="Delete after"
            :aria-valuenow="value"
            :aria-valuetext="summary"
            aria-valuemin="1"
            :aria-valuemax="maxMinutes"
            @pointerdown.prevent="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @keydown="onKeyDown"
        >
            <circle class="clock-rim" cx="100" cy="100" r="96"></circle>
            <circle class="clock-track" cx="100" cy="100" r="84"></circle>
            <path class="clock-progress" :d="arcPath"></path>
            <line
                v-for="tick in ticks"
                :key="tick"
                class="clock-tick"
                :class="{'major': tick % 5 == 0}"
                x1="100" :y1="tick % 5 == 0 ? 8 : 10" x2="100" y2="16"
                :transform="'rotate(' + (tick * 6) + ' 100 100)'"
            ></line>
            <text class="clock-number" x="100" y="36">0</text>
            <text class="clock-number" x="167" y="104">15</text>
            <text class="clock-number" x="100" y="172">30</text>
            <text class="clock-number" x="33" y="104">45</text>
            <text class="clock-hours" x="100" y="128">{{ fullHours > 0 ? "+" + fullHours + " h" : "" }}</text>
            <g class="clock-arm" :transform="'rotate(' + armAngle + ' 100 100)'">
                <line x1="100" y1="100" x2="100" y2="22"></line>
                <circle cx="100" cy="22" r="7"></circle>
            </g>
            <circle class="clock-pin" cx="100" cy="100" r="5"></circle>
        </svg>

        <div class="duration-fields">
            <label>
                <input type="number" min="0" :value="days" @change="setPart('days', $event.target.value)">
                <span>days</span>
            </label>
            <span class="duration-separator">:</span>
            <label>
                <input type="number" min="0" :value="hours" @change="setPart('hours', $event.target.value)">
                <span>hours</span>
            </label>
            <span class="duration-separator">:</span>
            <label>
                <input type="number" min="0" :value="minutes" @change="setPart('minutes', $event.target.value)">
                <span>minutes</span>
            </label>
        </div>

        <div class="duration-presets">
            <button
                v-for="preset in presets"
                :key="preset[1]"
                type="button"
                class="duration-preset"
                :class="{'active': value == preset[0]}"
                @click="setTotal(preset[0])"
            >{{ preset[1] }}</button>
        </div>
        <p class="duration-deletes-at">Deletes around {{ deletesAt }}</p>
    </div>`
});

Vue.component('folderItem', {
    created() {
        // console.log("folderItem created");
        this.isCollapsed = isCollapsedCache.get(this.contentObject.path);
    },
    data () {
        return {
            "isCollapsed": false,
        }
    },
    watch: {
        "isCollapsed": function () {
            isCollapsedCache.set(this.contentObject.path, this.isCollapsed);
        }
    },
    template: `<div class="folder-item" :class="{'closed': isCollapsed}">
        <div class="folder-name" @click="isCollapsed = !isCollapsed">
            /{{contentObject.path}}
        </div>
        <list-item
            v-for="content in contentObject.contents"
            :key="content.path"
            :content="content"
            :deletion="allowDeletion"
        />
    </div>`,
    props: ["contentObject", "allowDeletion"]
})

Vue.component('fileItem', {
    // created() { console.log("fileItem created");},
    template: `<div class="file-item">
        <a
            v-if="contentObject.protected"
            href="javascript:void(0);"
            class="file-name"
            @click="$unlockFile(contentObject)"
        >
            {{contentObject.name}}
        </a>
        <a
            v-else
            target="_blank"
            :href="'./f/' + contentObject.path"
            class="file-name"
            download
        >
            {{contentObject.name}}
        </a>
        <a
            v-if="allowDeletion"
            class="file-delete-button"
            @click="$deleteFile(contentObject.path)"
        >
            &times;
        </a>
        <a
            v-else-if="ownToken != null"
            class="file-delete-button"
            title="Delete your upload"
            @click="$deleteOwnFile(contentObject.path)"
        >
            &times;
        </a>
        <span v-if="contentObject.protected" class="file-badge" title="Password protected">&#128274;</span>
        <button
            v-if="ownPassword != null"
            type="button"
            class="file-badge file-badge-button"
            title="Show the password you generated"
            @click="$showPassword([contentObject.path], ownPassword)"
        >Password</button>
        <span v-if="deleteInText != null" class="file-badge" :title="'Deleted automatically in ' + deleteInText">&#9201; {{ deleteInText }}</span>
        <span v-if="contentObject.downloadsLeft != null" class="file-badge" title="Complete downloads left before deletion">&#11015; {{ contentObject.downloadsLeft }} left</span>
    </div>`,
    computed: {
        ownToken() {
            return ownedUploads.path2token[this.contentObject.path];
        },
        ownPassword() {
            return ownedUploads.path2password[this.contentObject.path];
        },
        deleteInText() {
            if (this.contentObject.deleteAt == null) return null;
            const remainingMs = this.contentObject.deleteAt - (uiClock.now + uiClock.serverSkewMs);
            return remainingMs < 60 * 1000 ? "<1m" : formatMinutes(Math.floor(remainingMs / (60 * 1000)));
        }
    },
    props: ["contentObject", "allowDeletion"]
})

Vue.component('listItem', {
    // created() { console.log("listItem created");},
    template: `<span>
        <folder-item
            v-if="content.folder"
            :contentObject="content"
            :allowDeletion="deletion"
        ></folder-item>
        <file-item
            v-if="!content.folder"
            :contentObject="content"
            :allowDeletion="deletion"
        ></file-item>
    </span>`,
    props: ["content", "deletion"]
})


// TODO(baris): comment
Vue.config.devtools = true

const fileListVueApp = new Vue({
    el: '#fileList',
    data: {
        rootContentObject: {"contents": []},
        allowDeletion: false
    },
    created() {
        // ...
    },
    methods: {
        /**
         * @param {Content} rootContentObject
         * @param {boolean} allowDeletion
         */
        updateFiles(rootContentObject, allowDeletion) {
            this.rootContentObject = rootContentObject;
            this.allowDeletion = allowDeletion;
        },
    }
})
Vue.prototype.$deleteFile = deleteFile;

/*
 * Options for the next upload, picked in the settings modal before file selection.
 * NOTE: Cleared on cancel and drag n drop, so those uploads never get them.
 */
/** @type {{deleteAfterMinutes: number|null, maxDownloads: number, protect: "auto"|"manual"|null, password: string|null}|null} */
let pendingUploadPolicy = null;
let isArmingAdvancedUpload = false;

const advancedModalVueApp = new Vue({
    el: '#advancedModal',
    data: {
        isOpen: false,
        /** @type {"autoDelete"|"downloadLimit"|"password"|null} -- only one section is expanded at a time */
        openSection: null,
        autoDelete: false,
        deleteAfterMinutes: 60,
        maxDownloads: -1,
        maxAutoDeleteMinutes: 30 * 24 * 60,
        /** @type {"off"|"auto"|"manual"} */
        passwordMode: "off",
        manualPassword: "",
        showPassword: false,
        minPasswordLength: 8,
        errorMessage: null
    },
    created() {
        document.addEventListener('keydown', (event) => {
            if (this.isOpen && event.key == "Escape") this.close();
        });
    },
    computed: {
        autoDeleteSummary() {
            return this.autoDelete ? formatMinutes(this.deleteAfterMinutes) : "Off";
        },
        downloadLimitSummary() {
            const maxDownloads = Number(this.maxDownloads);
            if (maxDownloads == -1) return "Unlimited";
            return maxDownloads + " download" + (maxDownloads == 1 ? "" : "s");
        },
        passwordSummary() {
            return { off: "Off", auto: "Generated", manual: "Own password" }[this.passwordMode];
        },
        passwordStrength() {
            const password = this.manualPassword;
            if (password.length < this.minPasswordLength) {
                return { level: "weak", text: `At least ${this.minPasswordLength} characters` };
            }
            const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
            // NOTE: Rough guide only, length matters most.
            if (password.length >= 16 || (password.length >= 12 && classes >= 3)) return { level: "strong", text: "Strong" };
            if (password.length >= 10 && classes >= 2) return { level: "ok", text: "OK, longer is stronger" };
            return { level: "weak", text: "Weak, use a longer password" };
        }
    },
    methods: {
        open() {
            this.errorMessage = null;
            this.openSection = null;
            this.manualPassword = "";
            this.showPassword = false;
            this.isOpen = true;
        },
        close() {
            this.isOpen = false;
        },
        toggleSection(section) {
            this.openSection = (this.openSection == section) ? null : section;
        },
        chooseFiles() {
            const maxDownloads = Number(this.maxDownloads);
            if (!Number.isInteger(maxDownloads) || !(maxDownloads == -1 || maxDownloads >= 1)) {
                this.errorMessage = "Download limit must be -1 (unlimited) or 1 and above.";
                this.openSection = "downloadLimit";
                return;
            }
            if (this.passwordMode == "manual" && this.manualPassword.length < this.minPasswordLength) {
                this.errorMessage = `The password needs at least ${this.minPasswordLength} characters.`;
                this.openSection = "password";
                return;
            }
            pendingUploadPolicy = {
                deleteAfterMinutes: this.autoDelete ? this.deleteAfterMinutes : null,
                maxDownloads: maxDownloads,
                protect: this.passwordMode == "off" ? null : this.passwordMode,
                password: this.passwordMode == "manual" ? this.manualPassword : null
            };
            this.manualPassword = "";
            this.close();
            isArmingAdvancedUpload = true;
            fileToUploadInputElement.click();
            isArmingAdvancedUpload = false;
        }
    }
});
Vue.prototype.$deleteOwnFile = deleteOwnFile;

/* Password protected files */

/**
 * @param {string} text
 * @param {HTMLInputElement} fallbackField -- selected and copied when the clipboard API is missing (plain HTTP)
 */
function copyText(text, fallbackField) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }
    fallbackField.focus();
    fallbackField.select();
    return document.execCommand("copy") ? Promise.resolve() : Promise.reject(new Error("copy failed"));
}

const passwordResultVueApp = new Vue({
    el: '#passwordResultModal',
    data: {
        isOpen: false,
        password: "",
        paths: [],
        copied: false
    },
    computed: {
        fileNames() {
            const names = this.paths.map((path) => path.split(/[\\/]/).pop());
            return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
        }
    },
    methods: {
        open(paths, password) {
            this.paths = paths;
            this.password = password;
            this.copied = false;
            this.isOpen = true;
            this.$nextTick(() => this.$refs.passwordField && this.$refs.passwordField.select());
        },
        close() {
            this.isOpen = false;
        },
        copy() {
            copyText(this.password, this.$refs.passwordField).then(() => {
                this.copied = true;
            }, () => {
                this.$refs.passwordField.select();
            });
        }
    }
});
Vue.prototype.$showPassword = (paths, password) => passwordResultVueApp.open(paths, password);

const unlockVueApp = new Vue({
    el: '#unlockModal',
    data: {
        isOpen: false,
        path: null,
        fileName: "",
        password: "",
        isBusy: false,
        errorMessage: null,
        attemptsLeft: null,
        bannedUntil: null
    },
    computed: {
        bannedUntilText() {
            if (this.bannedUntil == null) return "";
            return new Date(this.bannedUntil - uiClock.serverSkewMs).toLocaleString([], {
                weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
            });
        }
    },
    methods: {
        /** @param {Content} contentObject */
        open(contentObject) {
            this.path = contentObject.path;
            this.fileName = contentObject.name;
            this.password = "";
            this.errorMessage = null;
            this.isOpen = true;
            this.$nextTick(() => this.$refs.passwordField && this.$refs.passwordField.focus());
        },
        close() {
            this.isOpen = false;
            this.password = "";
        },
        unlock() {
            if (this.isBusy || this.password == "") return;
            this.isBusy = true;
            this.errorMessage = null;
            const request = new XMLHttpRequest();
            request.open('POST', './unlock', true);
            request.setRequestHeader('Content-Type', 'application/json');
            request.onload = () => {
                this.isBusy = false;
                let body = {};
                try {
                    body = JSON.parse(request.responseText);
                } catch (error) {
                    // NOTE: Some errors have no JSON body.
                }
                if (body.attemptsLeft != null) this.attemptsLeft = body.attemptsLeft;
                if (request.status == 200) {
                    this.close();
                    // NOTE: Attachment response, the page stays.
                    window.location.href = './d/' + encodeURIComponent(body.ticket);
                } else if (request.status == 429) {
                    this.bannedUntil = body.bannedUntil;
                } else if (request.status == 401) {
                    this.password = "";
                    this.errorMessage = `Wrong password, ${body.attemptsLeft} attempt${body.attemptsLeft == 1 ? "" : "s"} left.`;
                    this.$nextTick(() => this.$refs.passwordField && this.$refs.passwordField.focus());
                } else if (request.status == 404) {
                    this.errorMessage = "This file isn't available anymore.";
                } else {
                    this.errorMessage = "Something went wrong, try again.";
                }
            };
            request.onerror = () => {
                this.isBusy = false;
                this.errorMessage = "Couldn't reach the server.";
            };
            request.send(JSON.stringify({ "path": this.path, "password": this.password }));
        }
    }
});
Vue.prototype.$unlockFile = (contentObject) => unlockVueApp.open(contentObject);
document.addEventListener('keydown', (event) => {
    if (event.key != "Escape") return;
    passwordResultVueApp.close();
    unlockVueApp.close();
});

/**
 * @param {Content} rootContentObject
 * @param {boolean} allowDeletion
 */
function updateFiles(rootContentObject, allowDeletion) {
    console.log("rootContentObject", rootContentObject, allowDeletion);
    if (!(rootContentObject instanceof Object)) {
        fileListVueApp.updateFiles({"contents":[]}, allowDeletion);
        return;
    }
    fileListVueApp.updateFiles(rootContentObject, allowDeletion);
}

/**
 * @param {Content} contentObject
 * @param {boolean} allowDeletion
 * //TODO(baris) do this with document.createElement ? Use Virtual DOM instead ???
 */
function generateHTMLFromContentRecursive(contentObject, allowDeletion) {
    let strArray = [];

    if (contentObject.folder) {
        if (contentObject.path != "") {
            strArray.push(`<div class="folder-item">`);
            strArray.push(`<div class="folder-name" onclick="this.parentNode.classList.toggle('closed')">/${contentObject.path}</div>`);
        }

        strArray.push(...contentObject.contents.map((childContentObject) => {
            return generateHTMLFromContentRecursive(childContentObject, allowDeletion);
        }));

        if (contentObject.path != "") {
            strArray.push(`</div>`);
        }
    } else {
        strArray.push(`<div class="file-item">`);
        strArray.push(`<a target="_blank" href="./f/${contentObject.path}" class="file-name" download>${contentObject.name}</a>`);
        if (allowDeletion) {
            strArray.push(`<a class="file-delete-button" href="javascript:void(0);" onclick="deleteFile('${contentObject.path}')">&times;</a>`);
        }
        strArray.push(`</div>`);
    }
    return strArray.join('');
}

function deleteFile(path) {
    if (!confirm("Are you sure?")) return;
    const request = new XMLHttpRequest()
    request.open('GET', `./delete/` + encodeURIComponent(path), true)
    request.send();
}

function deleteOwnFile(path) {
    const token = ownedUploads.path2token[path];
    if (token == null) return;
    if (!confirm("Are you sure?")) return;
    const request = new XMLHttpRequest();
    request.open('POST', './delete-own', true);
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = function () {
        if (request.status == 200 || request.status == 403 || request.status == 404) {
            // NOTE: Either deleted or no longer deletable by us.
            Vue.delete(ownedUploads.path2token, path);
        }
        if (request.status != 200) {
            console.error("deleteOwnFile failed", request.status);
        }
    };
    request.send(JSON.stringify({ "path": path, "token": token }));
}

class ServerError extends Error {
    /**
     * @param {XMLHttpRequest} request
     */
    constructor(request) {
        super();
        this.request = request;
        this.name = "ServerError";
    }
}
class ConnectionError extends Error {
    /**
     * @param {XMLHttpRequest} request
     */
    constructor(request) {
        super();
        this.request = request;
        this.name = "ConnectionError";
    }
}

/**
 * @param {string} [oldMD5=null]
 * @returns {Promise<ServerInfoResult>}
 */
function getServerInfo(oldMD5 = null) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const URL = (oldMD5 != null ? `/info?md5=${encodeURIComponent(oldMD5)}` : '/info');
        request.open('GET', URL, true);

        request.onload = function () {
            if (request.status >= 200 && request.status < 400) {
                const data = JSON.parse(request.responseText);
                resolve(data);
            } else {
                console.error("getServerInfo server error", request);
                reject(new ServerError(request));
            }
        };
        request.onerror = function () {
            console.error("getServerInfo connection error", request);
            reject(new ConnectionError(request));
        };

        request.send();
    })
}

let multiUploadFileInput = false;
let folderUploadFileInput = false;
let previousRootContentMD5 = null;
function refreshInfoOnPage() {
    return getServerInfo(previousRootContentMD5).then((infoResult) => {
        const { addresses, port, rootContent, rootContentMD5, allowDeletion, multiUpload, folderUpload, maxAutoDeleteMinutes, minPasswordLength, serverTime } = infoResult;

        if (minPasswordLength != null) {
            advancedModalVueApp.minPasswordLength = minPasswordLength;
        }

        if (serverTime != null) {
            uiClock.now = Date.now();
            uiClock.serverSkewMs = serverTime - uiClock.now;
        }
        if (maxAutoDeleteMinutes != null) {
            advancedModalVueApp.maxAutoDeleteMinutes = maxAutoDeleteMinutes;
        }

        if (
            (addresses != null && (addresses instanceof Array)) &&
            (port != null && !isNaN(port))
        ) {
            updateAddressInfo(addresses, port, infoResult.scheme);
            updateAddressInfoStatus("success");
        }

        if (
            (previousRootContentMD5 == null) ||
            (previousRootContentMD5 != rootContentMD5)
        ) {
            updateFiles(rootContent, allowDeletion);
            previousRootContentMD5 = rootContentMD5;
        }
        
        if(multiUpload && !multiUploadFileInput) {
            multiUploadFileInput = true;
            fileToUploadInputElement.setAttribute("multiple", "");
        } else if(!multiUpload && multiUploadFileInput) {
            multiUploadFileInput = false;
            fileToUploadInputElement.removeAttribute("multiple");
        }
        
        if(folderUpload && !folderUploadFileInput) {
            folderUploadFileInput = true;
            fileToUploadInputElement.setAttribute("webkitdirectory", "");
        } else if(!folderUpload && folderUploadFileInput) {
            folderUploadFileInput = false;
            fileToUploadInputElement.removeAttribute("webkitdirectory");
        }
        

    }, (error) => {
        if (error instanceof ServerError) {
            updateAddressInfoStatus("warning");
        } else if (error instanceof ServerError) {
            updateAddressInfoStatus("error");
        } else {
            console.error("refreshInfoOnPage error", error);
        }
    }).then(() => {
        setTimeout(() => {
            refreshInfoOnPage();
        }, 1000);
    })
}
refreshInfoOnPage();

/* Query based upload success error stuff */

/** @type {URLSearchParams|Map<string, string>} */
let TheURLSearchParams = null;
try {
    let theURL = new URL(location.href);
    TheURLSearchParams = theURL.searchParams;
} catch (error) {
    console.error("URL parse error", error);
}
if (TheURLSearchParams == null) { // Dirty hack polyfill.
    try {
        /** @type {Array<[string, string]>} */
        let parts;
        if (location.search != null) {
            parts = (location.search.substring(1)).split("&").map((pairStr) => {
                let [key, rawValue] = pairStr.split("=");
                return [
                    key,
                    (
                        rawValue != null ?
                            decodeURIComponent(rawValue) :
                            null
                    )
                ];
            });
        } else {
            parts = [];
        }
        TheURLSearchParams = new Map(parts);
    } catch (error) {
        console.error("Manuel TheURLSearchParams parse error", error);
    }
}

function clearSearchQuery() {
    window.history.replaceState('obj', document.title, "http://" + location.host + location.pathname);
}

// if (TheURLSearchParams.has("success")) {
//     document.getElementById('successPanel').classList.remove("hidden");
//     document.getElementById('fileSuccessName').innerText = decodeURIComponent(TheURLSearchParams.get("success"));
//     clearSearchQuery();
// } else if (TheURLSearchParams.has("error")) {
//     document.getElementById('errorPanel').classList.remove("hidden");
//     clearSearchQuery();
// }

/* Drag n Drop Upload */

const dragDropHolder = document.body;
const fileToUploadButton = document.getElementById('fileToUploadButton');

dragDropHolder.ondragover = function (e) {
    e.preventDefault();
    e.stopPropagation();

    fileToUploadButton.style.position = "fixed";
    fileToUploadButton.style.top = (e.pageY - 11) + "px";
    fileToUploadButton.style.left = (e.pageX - 40) + "px";

};

const fixButtonBack = function () { fileToUploadButton.style.position = "static"; }
dragDropHolder.ondragend = fixButtonBack;
dragDropHolder.ondragexit = fixButtonBack;
dragDropHolder.ondragleave = function (e) {
    //console.log("holder.ondragleave",e);
    if (e.target == fileToUploadInputElement
        || e.pageX <= 10 || e.pageX >= window.innerWidth - 10
        || e.pageY <= 10 || e.pageY >= window.innerHeight - 10) {
        fixButtonBack();
    }
}
dragDropHolder.ondrop = function (e) {
    if (e.target != fileToUploadInputElement) {
        e.preventDefault();
    }
    // NOTE: A drag n drop upload is a plain upload.
    pendingUploadPolicy = null;
    fixButtonBack();
}

const errorPanelDiv = document.getElementById('errorPanel')

function handleFileUploadRequestEvents(eventName, event) {
    console.log("handleFileUploadRequestEvents", eventName);
    if(
        eventName == "load" ||
        eventName == "abort" ||
        eventName == "error" ||
        eventName == "timeout"
    ) {
        dragDropHolder.classList.remove("success");
        fileToUploadInputElement.value = "";
    }
    if (eventName == "load") {
        /** @type {XMLHttpRequest} */
        const request = event.target;
        if (request.status >= 200 && request.status < 300) {
            try {
                const { paths, token, expiresInMs, password } = JSON.parse(request.responseText);
                if (Array.isArray(paths) && typeof token == "string") {
                    addOwnedUploads(paths, token, expiresInMs);
                }
                if (Array.isArray(paths) && typeof password == "string") {
                    paths.forEach((path) => Vue.set(ownedUploads.path2password, path, password));
                    passwordResultVueApp.open(paths, password);
                }
            } catch (error) {
                console.error("upload response parse error", error);
            }
        } else {
            errorPanelDiv.classList.remove("hidden");
        }
    }
    if(
        eventName == "abort" ||
        eventName == "error" ||
        eventName == "timeout"
    ) {
        errorPanelDiv.classList.remove("hidden");
    }
}

/** @type {HTMLInputElement} */
// @ts-ignore
const progressMessageDiv = document.getElementById('progressMessage');

/** @type {HTMLInputElement} */
// @ts-ignore
const fileToUploadInputElement = document.getElementById('fileToUpload');
// NOTE: "Choose File" shows the settings modal first, its button opens the file picker.
fileToUploadInputElement.addEventListener('click', (event) => {
    if (isArmingAdvancedUpload) return;
    event.preventDefault();
    pendingUploadPolicy = null;
    advancedModalVueApp.open();
});
fileToUploadInputElement.addEventListener('cancel', () => {
    pendingUploadPolicy = null;
});
fileToUploadInputElement.onchange = function (e) {
    const files = Array.from(fileToUploadInputElement.files);
    console.log("fileToUploadInputElement.onchange files", files);
    
    dragDropHolder.classList.add("success");
    errorPanelDiv.classList.add("hidden");
    
    const uploadRequest = new XMLHttpRequest();
    uploadRequest.open('POST', "/", true);
    uploadRequest.setRequestHeader('Accept', 'application/json');
    
    uploadRequest.addEventListener('readystatechange', (event) => {handleFileUploadRequestEvents('readystatechange', event)});
    uploadRequest.addEventListener('load', (event) => {handleFileUploadRequestEvents('load', event)});
    uploadRequest.addEventListener('abort', (event) => {handleFileUploadRequestEvents('abort', event)});
    uploadRequest.addEventListener('error', (event) => {handleFileUploadRequestEvents('error', event)});
    uploadRequest.addEventListener('timeout', (event) => {handleFileUploadRequestEvents('timeout', event)});
    
    uploadRequest.upload.addEventListener('progress', (event) => {
        if(event.lengthComputable) {
            const percent = Math.floor((event.loaded / event.total) * 100);
            console.log('progress', percent);
            progressMessageDiv.innerText = percent + "%";
        } else {
            console.log('progress', uploadRequest);
            progressMessageDiv.innerHTML = "&nbsp;&nbsp;&nbsp;Uploading...";
        }
    });
    
    const formData = new FormData();
    // NOTE: Policy fields must come before the files, the server rejects them otherwise.
    if (pendingUploadPolicy != null) {
        if (pendingUploadPolicy.deleteAfterMinutes != null) {
            formData.append("deleteAfterMinutes", String(pendingUploadPolicy.deleteAfterMinutes));
        }
        formData.append("maxDownloads", String(pendingUploadPolicy.maxDownloads));
        if (pendingUploadPolicy.protect != null) {
            formData.append("protect", pendingUploadPolicy.protect);
            if (pendingUploadPolicy.password != null) formData.append("password", pendingUploadPolicy.password);
        }
        pendingUploadPolicy = null;
    }
    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const filePath = (
            (file.webkitRelativePath != null && file.webkitRelativePath != "") ?
            file.webkitRelativePath :
            file.name
        )
        formData.append(filePath, file);
    }
    
    uploadRequest.send(formData);
}
