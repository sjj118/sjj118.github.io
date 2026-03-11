// Written by Dor Verbin, October 2021
// This is based on: http://thenewcode.com/364/Interactive-Before-and-After-Video-Comparison-in-HTML5-Canvas
// With additional modifications based on: https://jsfiddle.net/7sk5k4gp/13/
// Modified by Keunhong Park to be responsive to window size.


Number.prototype.clamp = function (min, max) {
    return Math.min(Math.max(this, min), max);
};

class VideoPreloadManager {
    constructor() {
        this.widgets = [];
        this.visibleWidgets = new Set();

        this._bgAbortController = null;
        this._bgRunning = false;
        this._bgScheduled = false;
        this._bgCurrentWidget = null;
        this._bgScheduleHandle = null;
        this._bgScheduleType = null;
    }

    register(widget) {
        this.widgets.push(widget);
    }

    onShow(widget, signal = null) {
        this.visibleWidgets.add(widget);
        this._abortBackground();

        widget.playWhenReady({ signal }).then(() => {
            if (this._allVisibleReady()) {
                this._scheduleBackground();
            }
        }).catch((err) => {
            if (err && err.name === 'AbortError') {
                return;
            }
            console.warn('VideoComparison failed to load/play:', err);
        });
    }

    onHide(widget) {
        this.visibleWidgets.delete(widget);
        widget.pause();

        if (!widget.isReadyForPlayback()) {
            widget.abortLoad();
        } else {
            widget.setPreload('none');
        }
    }

    _allVisibleReady() {
        for (const widget of this.visibleWidgets) {
            if (!widget.isReadyForPlayback()) {
                return false;
            }
        }
        return true;
    }

    _scheduleBackground() {
        if (this._bgRunning || this._bgScheduled) {
            return;
        }

        this._bgScheduled = true;
        const run = () => {
            this._bgScheduled = false;
            this._bgScheduleHandle = null;
            this._bgScheduleType = null;
            this._runBackground();
        };

        if (typeof window.requestIdleCallback === 'function') {
            this._bgScheduleType = 'idle';
            this._bgScheduleHandle = window.requestIdleCallback(run, { timeout: 2000 });
        } else {
            this._bgScheduleType = 'timeout';
            this._bgScheduleHandle = window.setTimeout(run, 200);
        }
    }

    async _runBackground() {
        if (this._bgRunning) {
            return;
        }
        if (this.widgets.length === 0) {
            return;
        }
        if (this.visibleWidgets.size === 0) {
            return;
        }

        this._bgRunning = true;
        this._bgAbortController = typeof AbortController === 'function' ? new AbortController() : null;
        const signal = this._bgAbortController ? this._bgAbortController.signal : null;

        try {
            for (const widget of this.widgets) {
                if (signal && signal.aborted) {
                    return;
                }
                if (this.visibleWidgets.has(widget)) {
                    continue;
                }
                if (widget.isWarmed()) {
                    continue;
                }

                this._bgCurrentWidget = widget;
                try {
                    await widget.preloadInBackground({ signal });
                } catch (err) {
                    if (err && err.name === 'AbortError') {
                        return;
                    }
                    console.warn('Background preload failed:', err);
                } finally {
                    this._bgCurrentWidget = null;
                }
            }
        } finally {
            this._bgRunning = false;
            this._bgAbortController = null;
            this._bgCurrentWidget = null;
        }
    }

    _abortBackground() {
        if (this._bgScheduled && this._bgScheduleHandle !== null) {
            if (this._bgScheduleType === 'idle' && typeof window.cancelIdleCallback === 'function') {
                window.cancelIdleCallback(this._bgScheduleHandle);
            } else if (this._bgScheduleType === 'timeout') {
                window.clearTimeout(this._bgScheduleHandle);
            }
            this._bgScheduleHandle = null;
            this._bgScheduleType = null;
            this._bgScheduled = false;
        }

        if (this._bgAbortController) {
            this._bgAbortController.abort();
            this._bgAbortController = null;
        }

        if (this._bgCurrentWidget && !this.visibleWidgets.has(this._bgCurrentWidget)) {
            this._bgCurrentWidget.abortLoad();
        }
    }
}

window.VideoPreloadManager = window.VideoPreloadManager || new VideoPreloadManager();

class VideoComparison {
    constructor(container) {
        this.container = container;
        this.position = 0.5;
        this.canvas = container.find('canvas');
        this.video = container.find('video');
        this.context = this.canvas[0].getContext("2d");

        this.isPlaying = false;
        this._warmed = false;
        this._tabAbortController = null;

        this.label = container.data('label') || "Label 1"; // Get the first label, default to "Label 1"
        this.label2 = container.data('label2') || "Label 2"; // Get the second label, default to "Label 2"

        this.video[0].style.height = "0px";  // Hide video without stopping it
        // this.video[0].playbackRate = 0.5;

        let self = this;
        container.on('tab:show', function (e) {
            if (self._tabAbortController) {
                self._tabAbortController.abort();
            }
            self._tabAbortController = typeof AbortController === 'function' ? new AbortController() : null;
            const signal = self._tabAbortController ? self._tabAbortController.signal : null;
            window.VideoPreloadManager.onShow(self, signal);
        });
        container.on('tab:hide', function(e) {
            if (self._tabAbortController) {
                self._tabAbortController.abort();
            }
            self._tabAbortController = null;
            window.VideoPreloadManager.onHide(self);
        });

        window.VideoPreloadManager.register(this);

        function trackLocation(e) {
            // Normalize to [0, 1]
            self.bcr = self.canvas[0].getBoundingClientRect();
            self.position = ((e.pageX - self.bcr.x) / self.bcr.width);
        }
        function trackLocationTouch(e) {
            // Normalize to [0, 1]
            self.bcr = self.canvas[0].getBoundingClientRect();
            self.position = ((e.touches[0].pageX - self.bcr.x) / self.bcr.width);
        }

        this.canvas.on('mousemove', trackLocation);
        this.canvas.on('touchstart', trackLocationTouch);
        this.canvas.on('touchmove', trackLocationTouch);
        this.canvas.on('mouseout', function () { self.position = 0.5; });

        $(window).on('resize', function (e) {
            self.resize();
        });
    }

    resize() {
        const videoWidth = this.video[0].videoWidth / 2;
        const videoHeight = this.video[0].videoHeight;
        if (!videoWidth || !videoHeight) {
            return;
        }
        const canvasWidth = this.container.width();
        const canvasHeight = canvasWidth * videoHeight / videoWidth;
        this.canvas[0].width = canvasWidth;
        this.canvas[0].height = canvasHeight;
    }

    play() {
        this.resize();
        if (this.isPlaying) {
            return;
        }
        console.log('Playing video', this.video[0])
        this.isPlaying = true;
        this.video[0].play();
        this.drawLoop();
    }

    pause() {
        this.video[0].pause();
        this.isPlaying = false;
    }

    isReadyForPlayback() {
        return this.video[0].readyState >= 3;
    }

    isWarmed() {
        return this._warmed;
    }

    setPreload(mode) {
        this.video[0].preload = mode;
    }

    ensureSrcAssigned() {
        const videoEl = this.video[0];
        if (videoEl.getAttribute('src')) {
            return true;
        }
        const dataSrc = videoEl.getAttribute('data-src');
        if (!dataSrc) {
            return false;
        }
        videoEl.setAttribute('src', dataSrc);
        return true;
    }

    load() {
        this.video[0].load();
    }

    abortLoad() {
        const videoEl = this.video[0];
        try {
            videoEl.pause();
        } catch (e) {
            // ignore
        }
        videoEl.removeAttribute('src');
        videoEl.preload = 'none';
        try {
            videoEl.load();
        } catch (e) {
            // ignore
        }
    }

    waitForCanPlay({ signal } = {}) {
        const videoEl = this.video[0];
        if (videoEl.readyState >= 3) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
                videoEl.removeEventListener('canplay', onCanPlay);
                videoEl.removeEventListener('error', onError);
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
            };

            const settle = (fn) => (arg) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                fn(arg);
            };

            const onCanPlay = settle(() => resolve());
            const onError = settle(() => reject(new Error('video error')));
            const onAbort = settle(() => reject(new DOMException('Aborted', 'AbortError')));

            videoEl.addEventListener('canplay', onCanPlay, { once: true });
            videoEl.addEventListener('error', onError, { once: true });

            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    playWhenReady({ signal } = {}) {
        if (!this.ensureSrcAssigned()) {
            return Promise.resolve();
        }

        if (this.isReadyForPlayback()) {
            this._warmed = true;
            this.play();
            return Promise.resolve();
        }

        this.setPreload('auto');
        const canPlayPromise = this.waitForCanPlay({ signal });
        this.load();

        return canPlayPromise.then(() => {
            this._warmed = true;
            this.play();
        });
    }

    preloadInBackground({ signal } = {}) {
        if (this._warmed) {
            return Promise.resolve();
        }
        if (!this.ensureSrcAssigned()) {
            this._warmed = true;
            return Promise.resolve();
        }

        if (this.isReadyForPlayback()) {
            this._warmed = true;
            this.abortLoad();
            return Promise.resolve();
        }

        this.setPreload('auto');
        const canPlayPromise = this.waitForCanPlay({ signal });
        this.load();

        return canPlayPromise.then(() => {
            this._warmed = true;
            // Stop network activity; rely on HTTP cache for a faster later play.
            this.abortLoad();
        });
    }

    drawLoop() {
        const self = this;
        const video = this.video[0];
        const container = this.container;
        const context = this.context;
        requestAnimationFrame(drawFrame);

        function drawFrame() {
            const videoWidth = video.videoWidth / 2;
            const videoHeight = video.videoHeight;
            const canvasWidth = container.width();
            const canvasHeight = canvasWidth * videoHeight / videoWidth;
            const position = self.position;

            context.drawImage(video, 0, 0, videoWidth, videoHeight, 0, 0, canvasWidth, canvasHeight);
            var colStart = (canvasWidth * position).clamp(0.0, canvasWidth);
            var colWidth = (canvasWidth - (canvasWidth * position)).clamp(0.0, canvasWidth);
            var sourceColStart = (videoWidth * position).clamp(0.0, videoWidth);
            var sourceColWidth = (videoWidth - (videoWidth * position)).clamp(0.0, videoWidth);
            context.drawImage(
                video,
                sourceColStart + videoWidth, 0,
                sourceColWidth, videoHeight,
                colStart, 0,
                colWidth, canvasHeight);

            var arrowLength = 0.09 * canvasHeight;
            var arrowheadWidth = 0.025 * canvasHeight;
            var arrowheadLength = 0.04 * canvasHeight;
            var arrowPosY = canvasHeight / 10;
            var arrowWidth = 0.007 * canvasHeight;
            var currX = canvasWidth * position;

            // Draw circle
            context.arc(currX, arrowPosY, arrowLength * 0.7, 0, Math.PI * 2, false);
            context.fillStyle = "#FFD79340";
            context.fill()

            // Draw border
            context.beginPath();
            context.moveTo(canvasWidth * position, 0);
            context.lineTo(canvasWidth * position, canvasHeight);
            context.closePath()
            context.strokeStyle = "#AAAAAA";
            context.lineWidth = 5;
            context.stroke();

            // Draw arrow
            context.beginPath();
            context.moveTo(currX, arrowPosY - arrowWidth / 2);

            // Move right until meeting arrow head
            context.lineTo(currX + arrowLength / 2 - arrowheadLength / 2, arrowPosY - arrowWidth / 2);

            // Draw right arrow head
            context.lineTo(currX + arrowLength / 2 - arrowheadLength / 2, arrowPosY - arrowheadWidth / 2);
            context.lineTo(currX + arrowLength / 2, arrowPosY);
            context.lineTo(currX + arrowLength / 2 - arrowheadLength / 2, arrowPosY + arrowheadWidth / 2);
            context.lineTo(currX + arrowLength / 2 - arrowheadLength / 2, arrowPosY + arrowWidth / 2);

            // Go back to the left until meeting left arrow head
            context.lineTo(currX - arrowLength / 2 + arrowheadLength / 2, arrowPosY + arrowWidth / 2);

            // Draw left arrow head
            context.lineTo(currX - arrowLength / 2 + arrowheadLength / 2, arrowPosY + arrowheadWidth / 2);
            context.lineTo(currX - arrowLength / 2, arrowPosY);
            context.lineTo(currX - arrowLength / 2 + arrowheadLength / 2, arrowPosY - arrowheadWidth / 2);
            context.lineTo(currX - arrowLength / 2 + arrowheadLength / 2, arrowPosY);

            context.lineTo(currX - arrowLength / 2 + arrowheadLength / 2, arrowPosY - arrowWidth / 2);
            context.lineTo(currX, arrowPosY - arrowWidth / 2);

            context.closePath();

            context.fillStyle = "#AAAAAA";
            context.fill();

            context.font = "35px 'Google Sans', sans-serif";
            context.fillStyle = "white";
            context.strokeStyle = 'black';
            context.lineWidth = 2;
            context.textAlign = "left";
            context.textBaseline = "bottom";
            context.strokeText(self.label, 10, 40)
            context.fillText(self.label, 10, 40);

            context.textAlign = "right";
            context.strokeText(self.label2, canvasWidth - 10, 40)
            context.fillText(self.label2, canvasWidth - 10, 40);

            if (self.isPlaying) {
                requestAnimationFrame(drawFrame);
            }
        }
    }
}
