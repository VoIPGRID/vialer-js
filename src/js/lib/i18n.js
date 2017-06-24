'use strict'

class I18n {
    constructor(app) {
        this.app = app
        if (this.app.env.extension && !this.app.env.extension.background) {
            $(() => this.processPage())
        }
    }


    translate(messageID, args) {
        if (this.app.browser.i18n) {
            return this.app.browser.i18n.getMessage(messageID, args)
        } 
    }


    processPage() {
        let translated = []

        // Translate text content.
        $('[data-i18n-content]').not('.i18n-replaced').each((i, el) => {
            $(el).text(this.translate($(el).attr('data-i18n-content')))
            translated.push($(el))
        })

        // Translate attributes.
        $('[data-i18n-attrs]').not('.i18n-replaced').each((i, el) => {
            // Example format:
            // <element data-i18n-attrs='{"attr-name": "messageID"}'>
            const attrs = $(el).data('i18n-attrs')
            for (const attr in attrs) {
                if (attrs.hasOwnProperty(attr)) {
                    $(el).attr(attr, this.translate(attrs[attr]))
                }
            }
            translated.push($(el))
        })

        $('[data-i18n-title]').not('.i18n-replaced').each((i, el) => {
            $(el).attr('title', this.translate($(el).attr('data-i18n-title')))
            translated.push($(el))
        })

        // Prevent translating elements multiple times.
        $(translated).each(function() {
            $(this).addClass('i18n-replaced')
        })
    }
}

module.exports = I18n
