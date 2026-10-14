
(() => {
    let modelMetadata = null;
    let scheduled = false;

    const clean = value =>
        String(value || "").replace(/\s+/g, " ").trim();

    const decimalComma = (value, digits) =>
        Number(value).toFixed(digits).replace(".", ",");

    async function loadMetadata() {
        const response = await fetch(
            `data/model_metadata.json?t=${Date.now()}`,
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error("Metadata model tidak dapat dibaca");
        }

        modelMetadata = await response.json();
        synchronizeMetrics();
    }

    function findValueElement(labelElement) {
        let container = labelElement.parentElement;

        for (let level = 0; level < 2 && container; level++) {
            const preferred = [
                ...container.querySelectorAll(
                    "strong, b, h1, h2, h3, h4, [class*='value']"
                )
            ].find(element => {
                const value = clean(element.textContent);
                return (
                    element !== labelElement &&
                    /^[-+]?\d+(?:[.,]\d+)?%?$/.test(value)
                );
            });

            if (preferred) return preferred;

            const leaves = [
                ...container.querySelectorAll("*")
            ].filter(element => {
                const value = clean(element.textContent);
                return (
                    element.children.length === 0 &&
                    element !== labelElement &&
                    /^[-+]?\d+(?:[.,]\d+)?%?$/.test(value)
                );
            });

            if (leaves.length) return leaves[0];

            container = container.parentElement;
        }

        return null;
    }

    function updateMetric(label, displayedValue) {
        const labels = [...document.querySelectorAll("body *")]
            .filter(element =>
                element.children.length === 0 &&
                clean(element.textContent).toLowerCase() ===
                label.toLowerCase()
            );

        labels.forEach(labelElement => {
            const valueElement = findValueElement(labelElement);

            if (
                valueElement &&
                clean(valueElement.textContent) !== displayedValue
            ) {
                valueElement.textContent = displayedValue;
            }
        });
    }

    function synchronizeMetrics() {
        if (!modelMetadata) return;

        updateMetric(
            "ROC-AUC",
            decimalComma(modelMetadata.roc_auc, 3)
        );

        updateMetric(
            "PR-AUC",
            decimalComma(modelMetadata.pr_auc, 3)
        );

        updateMetric(
            "Recall",
            `${Math.round(Number(modelMetadata.recall) * 100)}%`
        );

        updateMetric(
            "Threshold",
            decimalComma(modelMetadata.threshold, 3)
        );
    }

    function scheduleSynchronization() {
        if (scheduled) return;

        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;
            synchronizeMetrics();
        });
    }

    document.addEventListener("DOMContentLoaded", () => {
        loadMetadata().catch(console.error);

        const observer = new MutationObserver(
            scheduleSynchronization
        );

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
})();
