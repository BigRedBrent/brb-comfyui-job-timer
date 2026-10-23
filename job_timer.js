import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TIMER_ID = "job-timer-display";
const TOOLTIP_ID = "job-timer-tooltip";

// Show the times in gray (like ComfyUI's own job pop-up). Set to false for the normal text color.
const GRAY_TIMES = true;

// ComfyUI's own theme classes, copied from its Job Details pop-up, so this matches it and follows the theme.
const CLASS_PANEL = "w-[300px] min-w-[260px] rounded-lg border border-interface-stroke bg-interface-panel-surface shadow-md";
const CLASS_HEADER = "flex items-center border-b border-interface-stroke p-4";
const CLASS_HEADER_TEXT = "text-sm/normal font-normal text-text-primary";
const CLASS_BODY = "flex flex-col gap-6 p-4";
const CLASS_GRID = "grid grid-cols-2 items-center gap-2";
const CLASS_LABEL = "flex items-center text-xs/normal font-normal text-text-primary";
const CLASS_VALUE_GRAY = "flex min-w-0 items-center text-xs/normal font-normal text-text-secondary";
const CLASS_VALUE_PLAIN = "flex min-w-0 items-center text-xs/normal font-normal text-text-primary";
const CLASS_VALUE_TEXT = "block min-w-0 truncate";
const CLASS_COPY_BUTTON =
    "relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap " +
    "appearance-none border-none rounded-md text-sm font-medium font-inter transition-colors " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none " +
    "disabled:opacity-50 bg-transparent text-muted-foreground hover:bg-secondary-background-hover size-8";
const CLASS_COPY_ICON = "icon-[lucide--copy] size-4";
const CLASS_TIMER_GRAY = "text-text-secondary";

// How often to refresh job information from ComfyUI, and how often to update the display.
const POLL_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 1000;
// How long the pop-up stays open after the mouse leaves, so you can move onto it to use the copy button.
const HIDE_DELAY_MS = 250;

// Current running job, worked out from ComfyUI's job list.
let runningJob = null; // { id, workflowId, startMs, estimateMs }
// Start times caught live from ComfyUI as jobs begin, used when available.
const liveStartTimes = new Map();

function formatDuration(totalMs) {
    // 45s, 30m 58s, 1h 5m 3s
    const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

function formatClockTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

// How many recently finished jobs to ask for. Only new ones are used, so a few is plenty.
const RECENT_FINISHED_TO_FETCH = 10;

async function fetchJobList(query) {
    const response = await api.fetchApi(`/jobs?${query}`);
    if (!response.ok) {
        throw new Error(`Job list request failed: ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data.jobs) ? data.jobs : [];
}

async function fetchJobs() {
    // Ask only for what's needed: the running job and the few most recently finished ones.
    // Waiting jobs are never downloaded, however long the queue is.
    const [running, finished] = await Promise.all([
        fetchJobList("status=in_progress&limit=1"),
        fetchJobList(`status=completed,failed,cancelled&limit=${RECENT_FINISHED_TO_FETCH}`),
    ]);
    // Older ComfyUI versions may ignore the filters and send everything twice, so drop repeats.
    const byId = new Map();
    for (const job of running.concat(finished)) {
        byId.set(job.id, job);
    }
    return Array.from(byId.values());
}

// Settings fields that name the main model a job uses (checkpoint or diffusion model loaders, including GGUF).
const MODEL_FIELDS = ["ckpt_name", "unet_name"];
// Each job's model and timing settings, recorded when it's queued from this page (or looked up once from
// ComfyUI's history if it wasn't). Only the most recent ones are kept.
const jobInfoCache = new Map();
const JOB_INFO_CACHE_LIMIT = 200;

function rememberJobInfo(jobId, info) {
    jobInfoCache.delete(jobId);
    jobInfoCache.set(jobId, info);
    while (jobInfoCache.size > JOB_INFO_CACHE_LIMIT) {
        jobInfoCache.delete(jobInfoCache.keys().next().value);
    }
}

function isLink(value) {
    // In a job's saved settings, a wire from another node is stored as [nodeId, outputIndex].
    return Array.isArray(value) && value.length === 2 && typeof value[1] === "number";
}

function loaderModelName(node) {
    const inputs = node && node.inputs;
    if (!inputs) {
        return null;
    }
    for (const field of MODEL_FIELDS) {
        if (typeof inputs[field] === "string") {
            return inputs[field];
        }
    }
    return null;
}

function resolveBoolean(prompt, value, depth = 0) {
    // A switch's true/false is either written on it, or wired from a node that holds the value.
    if (typeof value === "boolean") {
        return value;
    }
    if (!isLink(value) || depth > 10) {
        return null;
    }
    const source = prompt[value[0]];
    if (!source || !source.inputs) {
        return null;
    }
    for (const input of Object.values(source.inputs)) {
        const resolved = resolveBoolean(prompt, input, depth + 1);
        if (resolved !== null) {
            return resolved;
        }
    }
    return null;
}

function switchChoice(prompt, node) {
    // Recognize a switch: a true/false setting plus a "true" input and a "false" input, as in
    // ComfyUI's built-in Switch and most switch nodes from other packs. Returns the chosen input's wire.
    const inputs = node.inputs || {};
    let trueInput = null;
    let falseInput = null;
    let flag = null;
    for (const [name, value] of Object.entries(inputs)) {
        const lower = name.toLowerCase();
        if (isLink(value) && lower.includes("true")) {
            trueInput = value;
        } else if (isLink(value) && lower.includes("false")) {
            falseInput = value;
        } else if (flag === null) {
            flag = resolveBoolean(prompt, value);
        }
    }
    if (!trueInput || !falseInput || flag === null) {
        return null;
    }
    return flag ? trueInput : falseInput;
}

function traceModel(prompt, link, visited, found, depth = 0) {
    // Follow a model wire backward to the loader that supplies it, taking the selected side of any switch.
    if (!isLink(link) || depth > 50) {
        return;
    }
    const nodeId = String(link[0]);
    if (visited.has(nodeId)) {
        return;
    }
    visited.add(nodeId);
    const node = prompt[nodeId];
    if (!node) {
        return;
    }

    const name = loaderModelName(node);
    if (name) {
        found.add(name);
        return;
    }

    const chosen = switchChoice(prompt, node);
    if (chosen) {
        traceModel(prompt, chosen, visited, found, depth + 1);
        return;
    }

    // Pass-through nodes (LoRA loaders, model patches, memory clears and so on): keep following the model wire.
    const inputs = node.inputs || {};
    if (isLink(inputs.model)) {
        traceModel(prompt, inputs.model, visited, found, depth + 1);
        return;
    }
    for (const value of Object.values(inputs)) {
        if (isLink(value)) {
            traceModel(prompt, value, visited, found, depth + 1);
        }
    }
}

function modelSetFromPrompt(prompt) {
    // Work out which model file(s) actually reach the samplers, by following every "model" wire backward.
    if (!prompt || typeof prompt !== "object") {
        return null;
    }
    const found = new Set();
    for (const node of Object.values(prompt)) {
        const inputs = node && node.inputs;
        if (inputs && isLink(inputs.model)) {
            traceModel(prompt, inputs.model, new Set(), found);
        }
    }

    // Fallback if nothing could be traced: every loader in the job.
    if (found.size === 0) {
        for (const node of Object.values(prompt)) {
            const name = loaderModelName(node);
            if (name) {
                found.add(name);
            }
        }
    }
    return found.size > 0 ? Array.from(found).sort().join("|") : null;
}

// Settings that change how long a job takes, looked for by name in any node.
const TIMING_FIELDS = [
    "width",
    "height",
    "length",
    "frames",
    "num_frames",
    "frame_count",
    "duration",
    "seconds",
    "frame_rate",
    "fps",
    "steps",
];

function isPlainValue(value) {
    return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

function sourceNodeSettings(prompt, link) {
    // A value wired in from another node isn't saved with the job, only the wire is. Use the source
    // node's own typed-in settings instead: if they match, it produces the same value.
    const source = prompt[link[0]];
    if (!source) {
        return "?";
    }
    const settings = Object.entries(source.inputs || {})
        .filter(([, value]) => isPlainValue(value))
        .map(([name, value]) => `${name}=${value}`)
        .sort()
        .join(",");
    return `${source.class_type || "?"}[${link[1]}](${settings})`;
}

function timingSettingsFromPrompt(prompt) {
    // Collect clip length, size, frame rate and steps from every node, typed in or wired in.
    if (!prompt || typeof prompt !== "object") {
        return "";
    }
    const parts = [];
    for (const [nodeId, node] of Object.entries(prompt)) {
        const inputs = (node && node.inputs) || {};
        for (const field of TIMING_FIELDS) {
            if (!(field in inputs)) {
                continue;
            }
            const value = inputs[field];
            let text = null;
            if (isPlainValue(value)) {
                text = String(value);
            } else if (isLink(value)) {
                text = sourceNodeSettings(prompt, value);
            }
            if (text !== null) {
                parts.push(`${node.class_type || nodeId}.${field}=${text}`);
            }
        }
    }
    return parts.sort().join("|");
}

function jobInfoFromPrompt(prompt) {
    return { model: modelSetFromPrompt(prompt), settings: timingSettingsFromPrompt(prompt) };
}

async function fetchJobInfo(jobId) {
    // A job's settings: recorded when it was queued from this page, or else looked up once for that one job
    // (running or finished). Never downloads the queue.
    if (jobInfoCache.has(jobId)) {
        return jobInfoCache.get(jobId);
    }
    let info = null;
    try {
        // Newer ComfyUI: the single job's details, which include its settings.
        const response = await api.fetchApi(`/jobs/${encodeURIComponent(jobId)}`);
        if (response.ok) {
            const data = await response.json();
            const prompt = data && data.workflow && data.workflow.prompt;
            if (prompt && typeof prompt === "object") {
                info = jobInfoFromPrompt(prompt);
            }
        }
    } catch (error) {
        info = null;
    }
    if (!info) {
        try {
            // Older ComfyUI: finished jobs only, from the history.
            const response = await api.fetchApi(`/history/${jobId}`);
            if (response.ok) {
                const data = await response.json();
                const record = data[jobId];
                info = record && record.prompt ? jobInfoFromPrompt(record.prompt[2]) : null;
            }
        } catch (error) {
            info = null;
        }
    }
    rememberJobInfo(jobId, info);
    return info;
}

// The last few durations for each model + settings combination, added to as jobs finish.
const RECENT_DURATIONS_KEPT = 5;
const recentDurations = new Map();
// Finished jobs already seen, so each one is recorded only once. Empty until the first check.
let seenFinished = null;

function durationKey(info) {
    return info && info.model ? `${info.model}||${info.settings}` : null;
}

function isFinished(job) {
    return (
        job.status === "completed" &&
        typeof job.execution_start_time === "number" &&
        typeof job.execution_end_time === "number"
    );
}

async function recordNewlyFinished(jobs) {
    // Record jobs that finished since the last check. Jobs that had already finished when the page
    // loaded are skipped, so there's never a burst of lookups.
    const finished = jobs.filter(isFinished);
    const finishedIds = new Set(finished.map((job) => job.id));
    if (seenFinished === null) {
        seenFinished = finishedIds;
        return;
    }
    const newlyFinished = finished
        .filter((job) => !seenFinished.has(job.id))
        .sort((a, b) => a.execution_end_time - b.execution_end_time);
    seenFinished = finishedIds;
    for (const job of newlyFinished) {
        const key = durationKey(await fetchJobInfo(job.id));
        if (!key) {
            continue;
        }
        const list = recentDurations.get(key) || [];
        list.push(job.execution_end_time - job.execution_start_time);
        while (list.length > RECENT_DURATIONS_KEPT) {
            list.shift();
        }
        recentDurations.set(key, list);
    }
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function workOutEstimate(running) {
    // The median (middle value) of the last 5 finished jobs that used the same model AND the same clip
    // length, size, frame rate and steps, so an occasional unusually slow job doesn't throw it off.
    const key = durationKey(await fetchJobInfo(running.id));
    const list = key ? recentDurations.get(key) : null;
    return list && list.length > 0 ? median(list) : null;
}

async function workOutRunningJob(jobs) {
    try {
        await recordNewlyFinished(jobs);
    } catch (error) {
        // Recorded next time.
    }
    const running = jobs.find((job) => job.status === "in_progress");
    if (!running) {
        return null;
    }

    // Start time: caught live if we saw it, otherwise the later of when it was queued
    // and when the previous job finished (jobs run one at a time).
    let startMs = liveStartTimes.get(running.id);
    if (!startMs) {
        let lastFinish = 0;
        for (const job of jobs) {
            if (typeof job.execution_end_time === "number" && job.execution_end_time > lastFinish) {
                lastFinish = job.execution_end_time;
            }
        }
        startMs = Math.max(running.create_time || 0, lastFinish);
    }

    let estimateMs = null;
    try {
        estimateMs = await workOutEstimate(running);
    } catch (error) {
        estimateMs = null;
    }

    return { id: running.id, workflowId: running.workflow_id || "", startMs, estimateMs };
}

let refreshing = false;

async function refreshJobs() {
    if (refreshing) {
        return;
    }
    refreshing = true;
    try {
        runningJob = await workOutRunningJob(await fetchJobs());
    } catch (error) {
        runningJob = null;
    } finally {
        refreshing = false;
    }
    updateDisplay();
}

function findButtonByText(text) {
    for (const button of document.querySelectorAll("button")) {
        if (button.textContent.trim() === text) {
            return button;
        }
    }
    return null;
}

function outermostWrapper(element) {
    // Walk up through wrappers that only hold this button, stopping where its neighbors are.
    let current = element;
    while (current.parentElement) {
        const neighbors = Array.from(current.parentElement.querySelectorAll("button")).filter(
            (other) => !current.contains(other)
        );
        if (neighbors.length > 0) {
            break;
        }
        current = current.parentElement;
    }
    return current;
}

function createTimer() {
    const timer = document.createElement("span");
    timer.id = TIMER_ID;
    timer.style.display = "none";
    timer.style.alignItems = "center";
    timer.style.whiteSpace = "nowrap";
    timer.style.cursor = "default";
    timer.style.fontVariantNumeric = "tabular-nums";
    // Recessed "clock display" box: a see-through dark tint (so it adapts to any theme),
    // a faint inner shadow to look pressed in, and rounded corners.
    timer.style.padding = "2px 8px";
    timer.style.margin = "0 4px";
    timer.style.borderRadius = "6px";
    timer.style.background = "rgba(0, 0, 0, 0.28)";
    timer.style.boxShadow = "inset 0 1px 2px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(0, 0, 0, 0.15)";
    if (GRAY_TIMES) {
        timer.className = CLASS_TIMER_GRAY;
    }
    timer.addEventListener("mouseenter", showTooltip);
    timer.addEventListener("mouseleave", scheduleHide);
    return timer;
}

function findRunBar() {
    // The run bar is the smallest box around the Run button that also holds the batch count box,
    // without reaching out to the Extensions button.
    const runButton = findButtonByText("Run");
    if (!runButton) {
        return null;
    }
    const extensionsButton = findButtonByText("Extensions");
    let element = runButton.parentElement;
    while (element) {
        if (extensionsButton && element.contains(extensionsButton)) {
            return null;
        }
        if (element.querySelector("input")) {
            return element;
        }
        element = element.parentElement;
    }
    return null;
}

function placeTimer() {
    // Inside the run bar, as its first (leftmost) item.
    const runBar = findRunBar();
    let timer = document.getElementById(TIMER_ID);
    if (runBar) {
        if (!timer) {
            timer = createTimer();
        }
        if (runBar.firstChild !== timer) {
            runBar.insertBefore(timer, runBar.firstChild);
        }
        return;
    }

    // Fallback: just to the right of the Extensions button.
    const extensionsButton = findButtonByText("Extensions");
    if (!extensionsButton) {
        return;
    }
    if (!timer) {
        timer = createTimer();
    }
    const anchor = outermostWrapper(extensionsButton);
    if (anchor.nextSibling !== timer) {
        anchor.parentElement.insertBefore(timer, anchor.nextSibling);
    }
}

// ---- Pop-up (laid out like ComfyUI's Job Details pop-up) ----

// Parts of the pop-up that change while it's open.
const tooltipParts = {
    jobId: null,
    workflowValue: null,
    jobIdValue: null,
    startedValue: null,
    elapsedValue: null,
    estimateLabel: null,
    estimateValue: null,
};

function makeLabel(text) {
    const label = document.createElement("div");
    label.className = CLASS_LABEL;
    label.textContent = text;
    return label;
}

function makeValue() {
    // Returns [cell, textSpan]: the cell holds the text and, for Job ID, the copy button.
    const cell = document.createElement("div");
    cell.className = GRAY_TIMES ? CLASS_VALUE_GRAY : CLASS_VALUE_PLAIN;
    const text = document.createElement("span");
    text.className = CLASS_VALUE_TEXT;
    cell.appendChild(text);
    return [cell, text];
}

async function copyJobId(button) {
    const jobId = tooltipParts.jobId;
    if (!jobId) {
        return;
    }
    try {
        await navigator.clipboard.writeText(jobId);
        button.setAttribute("aria-label", "Copied");
        button.title = "Copied";
        button.style.opacity = "0.5";
        setTimeout(() => {
            button.setAttribute("aria-label", "Copy");
            button.title = "Copy";
            button.style.opacity = "";
        }, 800);
    } catch (error) {
        console.error("[Job Timer] Could not copy the job ID:", error);
    }
}

function buildTooltip(tooltip) {
    const header = document.createElement("div");
    header.className = CLASS_HEADER;
    const headerText = document.createElement("span");
    headerText.className = CLASS_HEADER_TEXT;
    headerText.textContent = "Job Details";
    header.appendChild(headerText);

    const body = document.createElement("div");
    body.className = CLASS_BODY;

    // Workflow and Job ID.
    const idGrid = document.createElement("div");
    idGrid.className = CLASS_GRID;
    const [workflowCell, workflowValue] = makeValue();
    const [jobIdCell, jobIdValue] = makeValue();
    const copyButton = document.createElement("button");
    copyButton.className = CLASS_COPY_BUTTON;
    copyButton.setAttribute("aria-label", "Copy");
    copyButton.title = "Copy";
    const copyIcon = document.createElement("i");
    copyIcon.className = CLASS_COPY_ICON;
    copyButton.appendChild(copyIcon);
    copyButton.addEventListener("click", () => copyJobId(copyButton));
    jobIdCell.appendChild(copyButton);
    idGrid.append(makeLabel("Workflow"), workflowCell, makeLabel("Job ID"), jobIdCell);

    // Times.
    const timeGrid = document.createElement("div");
    timeGrid.className = CLASS_GRID;
    const [startedCell, startedValue] = makeValue();
    const [elapsedCell, elapsedValue] = makeValue();
    const [estimateCell, estimateValue] = makeValue();
    const estimateLabel = makeLabel("Estimated to finish in");
    timeGrid.append(
        makeLabel("Started at"),
        startedCell,
        makeLabel("Time elapsed"),
        elapsedCell,
        estimateLabel,
        estimateCell
    );

    body.append(idGrid, timeGrid);
    tooltip.replaceChildren(header, body);

    tooltipParts.workflowValue = workflowValue;
    tooltipParts.jobIdValue = jobIdValue;
    tooltipParts.startedValue = startedValue;
    tooltipParts.elapsedValue = elapsedValue;
    tooltipParts.estimateLabel = estimateLabel;
    tooltipParts.estimateValue = estimateValue;
}

function getTooltip() {
    let tooltip = document.getElementById(TOOLTIP_ID);
    if (tooltip) {
        return tooltip;
    }
    tooltip = document.createElement("div");
    tooltip.id = TOOLTIP_ID;
    tooltip.className = CLASS_PANEL;
    Object.assign(tooltip.style, {
        position: "fixed",
        zIndex: "10000",
        display: "none",
        fontVariantNumeric: "tabular-nums",
    });
    tooltip.addEventListener("mouseenter", cancelHide);
    tooltip.addEventListener("mouseleave", scheduleHide);
    buildTooltip(tooltip);
    document.body.appendChild(tooltip);
    return tooltip;
}

function updateTooltip() {
    if (!runningJob) {
        return;
    }
    getTooltip();
    const now = Date.now();
    tooltipParts.jobId = runningJob.id;
    tooltipParts.workflowValue.textContent = runningJob.workflowId;
    tooltipParts.jobIdValue.textContent = runningJob.id;
    tooltipParts.startedValue.textContent = formatClockTime(runningJob.startMs);
    tooltipParts.elapsedValue.textContent = formatDuration(now - runningJob.startMs);

    // The estimate row is always shown; its value stays blank until there's a matching finished job to estimate from.
    const hasEstimate = runningJob.estimateMs !== null;
    if (hasEstimate) {
        const remaining = runningJob.startMs + runningJob.estimateMs - now;
        tooltipParts.estimateValue.textContent = `~${formatDuration(remaining)}`;
    } else {
        tooltipParts.estimateValue.textContent = "";
    }
}

let tooltipVisible = false;
let hideTimer = null;

function positionTooltip() {
    const timer = document.getElementById(TIMER_ID);
    const tooltip = getTooltip();
    if (!timer) {
        return;
    }
    const rect = timer.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipWidth - 8));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
}

function cancelHide() {
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
}

function showTooltip() {
    cancelHide();
    if (!runningJob) {
        return;
    }
    tooltipVisible = true;
    updateTooltip();
    getTooltip().style.display = "block";
    positionTooltip();
}

function hideTooltip() {
    cancelHide();
    tooltipVisible = false;
    getTooltip().style.display = "none";
}

function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hideTooltip, HIDE_DELAY_MS);
}

function updateDisplay() {
    placeTimer();
    const timer = document.getElementById(TIMER_ID);
    if (!timer) {
        return;
    }
    if (!runningJob) {
        timer.style.display = "none";
        timer.textContent = "";
        hideTooltip();
        return;
    }
    timer.style.display = "inline-flex";
    timer.textContent = formatDuration(Date.now() - runningJob.startMs);
    if (tooltipVisible) {
        updateTooltip();
        positionTooltip();
    }
}

let scheduled = false;

function schedulePlace() {
    if (scheduled) {
        return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        placeTimer();
    });
}

app.registerExtension({
    name: "JobTimer",
    setup() {
        // Catch the exact start time when a job begins running, if this page is open.
        api.addEventListener("execution_start", (event) => {
            const promptId = event?.detail?.prompt_id;
            if (promptId) {
                liveStartTimes.set(promptId, Date.now());
            }
            refreshJobs();
        });
        for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
            api.addEventListener(name, () => refreshJobs());
        }

        // Record each job's model and settings as it's queued from this page, so they never have to be
        // downloaded from ComfyUI's queue later.
        if (typeof api.queuePrompt === "function") {
            const originalQueuePrompt = api.queuePrompt.bind(api);
            api.queuePrompt = async function (...args) {
                const result = await originalQueuePrompt(...args);
                try {
                    const data = args.find((arg) => arg && typeof arg === "object" && arg.output);
                    const jobId = result && result.prompt_id;
                    if (data && jobId) {
                        rememberJobInfo(jobId, jobInfoFromPrompt(data.output));
                    }
                } catch (error) {
                    // No estimate for this job.
                }
                return result;
            };
        }

        // Keep the timer in place if the toolbar is rebuilt.
        const observer = new MutationObserver(schedulePlace);
        observer.observe(document.body, { childList: true, subtree: true });

        refreshJobs();
        setInterval(refreshJobs, POLL_INTERVAL_MS);
        setInterval(updateDisplay, TICK_INTERVAL_MS);
    },
});
