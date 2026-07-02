import { App, Modal, Setting } from "obsidian";

export function promptText(
	app: App,
	title: string,
	options: { placeholder?: string; value?: string; submitText?: string } = {},
): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new TextPromptModal(app, title, options, resolve);
		modal.open();
	});
}

class TextPromptModal extends Modal {
	private value: string;
	private resolved = false;

	constructor(
		app: App,
		private title: string,
		private options: { placeholder?: string; value?: string; submitText?: string },
		private resolve: (value: string | null) => void,
	) {
		super(app);
		this.value = options.value ?? "";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("critic-prompt-modal");
		contentEl.createEl("h2", { text: this.title });

		new Setting(contentEl).addTextArea((text) => {
			text
				.setPlaceholder(this.options.placeholder ?? "")
				.setValue(this.value)
				.onChange((value) => {
					this.value = value;
				});
			text.inputEl.rows = 4;
			text.inputEl.focus();
			text.inputEl.select();
			text.inputEl.addEventListener("keydown", (event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
					event.preventDefault();
					this.submit();
				}
			});
		});

		const actions = contentEl.createDiv({ cls: "critic-prompt-actions" });
		const cancel = actions.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.cancel());
		const submit = actions.createEl("button", {
			cls: "mod-cta",
			text: this.options.submitText ?? "Insert",
		});
		submit.addEventListener("click", () => this.submit());
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(null);
		}
	}

	private submit(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(this.value);
		this.close();
	}

	private cancel(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(null);
		this.close();
	}
}
