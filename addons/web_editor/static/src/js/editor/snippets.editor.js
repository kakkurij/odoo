odoo.define('web_editor.snippet.editor', function (require) {
'use strict';

var concurrency = require('web.concurrency');
var core = require('web.core');
var Dialog = require('web.Dialog');
var dom = require('web.dom');
var Widget = require('web.Widget');
var options = require('web_editor.snippets.options');
var Wysiwyg = require('web_editor.wysiwyg');
const {ColorPaletteWidget} = require('web_editor.ColorPalette');
const SmoothScrollOnDrag = require('web/static/src/js/core/smooth_scroll_on_drag.js');
const {getCSSVariableValue} = require('web_editor.utils');

var _t = core._t;

var globalSelector = {
    closest: () => $(),
    all: () => $(),
    is: () => false,
};

/**
 * Management of the overlay and option list for a snippet.
 */
var SnippetEditor = Widget.extend({
    template: 'web_editor.snippet_overlay',
    xmlDependencies: ['/web_editor/static/src/xml/snippets.xml'],
    events: {
        'click .oe_snippet_remove': '_onRemoveClick',
        'wheel': '_onMouseWheel',
    },
    custom_events: {
        'option_update': '_onOptionUpdate',
        'user_value_widget_request': '_onUserValueWidgetRequest',
        'snippet_option_update': '_onSnippetOptionUpdate', // TODO remove me in master
        'snippet_option_visibility_update': '_onSnippetOptionVisibilityUpdate',
    },
    layoutElementsSelector: [
        '.o_we_shape',
        '.o_we_bg_filter',
    ].join(','),

    /**
     * @constructor
     * @param {Widget} parent
     * @param {Element} target
     * @param {Object} templateOptions
     * @param {jQuery} $editable
     * @param {Object} options
     */
    init: function (parent, target, templateOptions, $editable, options) {
        this._super.apply(this, arguments);
        this.options = options;
        this.$editable = $editable;
        this.ownerDocument = this.$editable[0].ownerDocument;
        this.$body = $(this.ownerDocument.body);
        this.$target = $(target);
        this.$target.data('snippet-editor', this);
        this.templateOptions = templateOptions;
        this.isTargetParentEditable = false;
        this.isTargetMovable = false;
        this.$scrollingElement = $().getScrollingElement();

        this.__isStarted = new Promise(resolve => {
            this.__isStartedResolveFunc = resolve;
        });
    },
    /**
     * @override
     */
    start: function () {
        var defs = [this._super.apply(this, arguments)];

        // Initialize the associated options (see snippets.options.js)
        defs.push(this._initializeOptions());
        var $customize = this._customize$Elements[this._customize$Elements.length - 1];

        this.isTargetParentEditable = this.$target.parent().is(':o_editable');
        this.isTargetMovable = this.isTargetParentEditable && this.isTargetMovable;
        this.isTargetRemovable = this.isTargetParentEditable && !this.$target.parent().is('[data-oe-type="image"]');

        // Initialize move/clone/remove buttons
        if (this.isTargetMovable) {
            this.dropped = false;
            const smoothScrollOptions = this.options.getScrollOptions({
                jQueryDraggableOptions: {
                    cursorAt: {
                        left: 10,
                        top: 10
                    },
                    handle: '.o_move_handle',
                    helper: () => {
                        var $clone = this.$el.clone().css({width: '24px', height: '24px', border: 0});
                        $clone.appendTo(this.$body).removeClass('d-none');
                        return $clone;
                    },
                    start: this._onDragAndDropStart.bind(this),
                    stop: (...args) => {
                        // Delay our stop handler so that some summernote handlers
                        // which occur on mouseup (and are themself delayed) are
                        // executed first (this prevents the library to crash
                        // because our stop handler may change the DOM).
                        setTimeout(() => {
                            this._onDragAndDropStop(...args);
                        }, 0);
                    },
                },
            });
            this.draggableComponent = new SmoothScrollOnDrag(this, this.$el, $().getScrollingElement(), smoothScrollOptions);
        } else {
            this.$('.o_overlay_move_options').addClass('d-none');
            $customize.find('.oe_snippet_clone').addClass('d-none');
        }

        if (!this.isTargetRemovable) {
            this.$el.add($customize).find('.oe_snippet_remove').addClass('d-none');
        }

        var _animationsCount = 0;
        var postAnimationCover = _.throttle(() => {
            this.trigger_up('cover_update', {
                overlayVisible: true,
            });
        }, 100);
        this.$target.on('transitionstart.snippet_editor, animationstart.snippet_editor', () => {
            // We cannot rely on the fact each transition/animation start will
            // trigger a transition/animation end as the element may be removed
            // from the DOM before or it could simply be an infinite animation.
            //
            // By simplicity, for each start, we add a delayed operation that
            // will decrease the animation counter after a fixed duration and
            // do the post animation cover if none is registered anymore.
            _animationsCount++;
            setTimeout(() => {
                if (!--_animationsCount) {
                    postAnimationCover();
                }
            }, 500); // This delay have to be huge enough to take care of long
                     // animations which will not trigger an animation end event
                     // but if it is too small for some, this is the job of the
                     // animation creator to manually ask for a re-cover
        });
        // On top of what is explained above, do the post animation cover for
        // each detected transition/animation end so that the user does not see
        // a flickering when not needed.
        this.$target.on('transitionend.snippet_editor, animationend.snippet_editor', postAnimationCover);

        return Promise.all(defs).then(() => {
            this.__isStartedResolveFunc(this);
        });
    },
    /**
     * @override
     */
    destroy: function () {
        // Before actually destroying a snippet editor, notify the parent
        // about it so that it can update its list of alived snippet editors.
        this.trigger_up('snippet_editor_destroyed');

        this._super(...arguments);
        this.$target.removeData('snippet-editor');
        this.$target.off('.snippet_editor');
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Checks whether the snippet options are shown or not.
     *
     * @returns {boolean}
     */
    areOptionsShown: function () {
        const lastIndex = this._customize$Elements.length - 1;
        return !!this._customize$Elements[lastIndex].parent().length;
    },
    /**
     * Notifies all the associated snippet options that the snippet has just
     * been dropped in the page.
     */
    buildSnippet: async function () {
        for (var i in this.styles) {
            this.styles[i].onBuilt();
        }
        await this.toggleTargetVisibility(true);
    },
    /**
     * Notifies all the associated snippet options that the template which
     * contains the snippet is about to be saved.
     */
    cleanForSave: async function () {
        if (this.isDestroyed()) {
            return;
        }
        await this.toggleTargetVisibility(!this.$target.hasClass('o_snippet_invisible'));
        const proms = _.map(this.styles, option => {
            return option.cleanForSave();
        });
        await Promise.all(proms);
    },
    /**
     * Closes all widgets of all options.
     */
    closeWidgets: function () {
        if (!this.styles || !this.areOptionsShown()) {
            return;
        }
        Object.keys(this.styles).forEach(key => {
            this.styles[key].closeWidgets();
        });
    },
    /**
     * Makes the editor overlay cover the associated snippet.
     */
    cover: function () {
        if (!this.isShown() || !this.$target.length) {
            return;
        }

        const $modal = this.$target.find('.modal');
        const $target = $modal.length ? $modal : this.$target;
        const targetEl = $target[0];

        // Check first if the target is still visible, otherwise we have to
        // hide it. When covering all element after scroll for instance it may
        // have been hidden (part of an affixed header for example) or it may
        // be outside of the viewport (the whole header during an effect for
        // example).
        const rect = targetEl.getBoundingClientRect();
        const vpWidth = window.innerWidth || document.documentElement.clientWidth;
        const vpHeight = window.innerHeight || document.documentElement.clientHeight;
        const isInViewport = (
            rect.bottom > -0.1 &&
            rect.right > -0.1 &&
            (vpHeight - rect.top) > -0.1 &&
            (vpWidth - rect.left) > -0.1
        );
        const hasSize = ( // :visible not enough for images
            Math.abs(rect.bottom - rect.top) > 0.01 &&
            Math.abs(rect.right - rect.left) > 0.01
        );
        if (!isInViewport || !hasSize || !this.$target.is(`:visible`)) {
            this.toggleOverlayVisibility(false);
            return;
        }

        // Now cover the element
        const offset = $target.offset();
        var manipulatorOffset = this.$el.parent().offset();
        offset.top -= manipulatorOffset.top;
        offset.left -= manipulatorOffset.left;
        this.$el.css({
            width: $target.outerWidth(),
            left: offset.left,
            top: offset.top,
        });
        this.$('.o_handles').css('height', $target.outerHeight());

        const editableOffsetTop = this.$editable.offset().top - manipulatorOffset.top;
        this.$el.toggleClass('o_top_cover', offset.top - editableOffsetTop < 25);
    },
    /**
     * DOMElements have a default name which appears in the overlay when they
     * are being edited. This method retrieves this name; it can be defined
     * directly in the DOM thanks to the `data-name` attribute.
     */
    getName: function () {
        if (this.$target.data('name') !== undefined) {
            return this.$target.data('name');
        }
        if (this.$target.is('img')) {
            return _t("Image");
        }
        if (this.$target.parent('.row').length) {
            return _t("Column");
        }
        return _t("Block");
    },
    /**
     * @return {boolean}
     */
    isShown: function () {
        return this.$el && this.$el.parent().length && this.$el.hasClass('oe_active');
    },
    /**
     * @returns {boolean}
     */
    isSticky: function () {
        return this.$el && this.$el.hasClass('o_we_overlay_sticky');
    },
    /**
     * @returns {boolean}
     */
    isTargetVisible: function () {
        return (this.$target[0].dataset.invisible !== '1');
    },
    /**
     * Removes the associated snippet from the DOM and destroys the associated
     * editor (itself).
     *
     * @returns {Promise}
     */
    removeSnippet: async function () {
        this.toggleOverlay(false);
        await this.toggleOptions(false);
        // If it is an invisible element, we must close it before deleting it (e.g. modal)
        await this.toggleTargetVisibility(!this.$target.hasClass('o_snippet_invisible'));

        await new Promise(resolve => {
            this.trigger_up('call_for_each_child_snippet', {
                $snippet: this.$target,
                callback: function (editor, $snippet) {
                    for (var i in editor.styles) {
                        editor.styles[i].onRemove();
                    }
                },
                onSuccess: resolve,
            });
        });

        this.trigger_up('go_to_parent', {$snippet: this.$target});
        var $parent = this.$target.parent();
        this.$target.find('*').addBack().tooltip('dispose');
        this.$target.remove();
        this.$el.remove();

        var node = $parent[0];
        if (node && node.firstChild) {
            if (!node.firstChild.tagName && node.firstChild.textContent === ' ') {
                node.removeChild(node.firstChild);
            }
        }

        if ($parent.closest(':data("snippet-editor")').length) {
            const isEmptyAndRemovable = ($el, editor) => {
                editor = editor || $el.data('snippet-editor');
                const isEmpty = $el.text().trim() === ''
                    && $el.children().toArray().every(el => {
                        // Consider layout-only elements (like bg-shapes) as empty
                        return el.matches(this.layoutElementsSelector);
                    });
                return isEmpty && !$el.hasClass('oe_structure')
                    && !$el.parent().hasClass('carousel-item')
                    && (!editor || editor.isTargetParentEditable);
            };

            var editor = $parent.data('snippet-editor');
            while (!editor) {
                var $nextParent = $parent.parent();
                if (isEmptyAndRemovable($parent)) {
                    $parent.remove();
                }
                $parent = $nextParent;
                editor = $parent.data('snippet-editor');
            }
            if (isEmptyAndRemovable($parent, editor)) {
                // TODO maybe this should be part of the actual Promise being
                // returned by the function ?
                setTimeout(() => editor.removeSnippet());
            }
        }

        // clean editor if they are image or table in deleted content
        this.$body.find('.note-control-selection').hide();
        this.$body.find('.o_table_handler').remove();

        this.trigger_up('snippet_removed');
        this.destroy();
        $parent.trigger('content_changed');
        // TODO Page content changed, some elements may need to be adapted
        // according to it. While waiting for a better way to handle that this
        // window trigger will handle most cases.
        $(window).trigger('resize');
    },
    /**
     * Displays/Hides the editor overlay.
     *
     * @param {boolean} show
     * @param {boolean} [previewMode=false]
     */
    toggleOverlay: function (show, previewMode) {
        if (!this.$el) {
            return;
        }

        if (previewMode) {
            // In preview mode, the sticky classes are left untouched, we only
            // add/remove the preview class when toggling/untoggling
            this.$el.toggleClass('o_we_overlay_preview', show);
        } else {
            // In non preview mode, the preview class is always removed, and the
            // sticky class is added/removed when toggling/untoggling
            this.$el.removeClass('o_we_overlay_preview');
            this.$el.toggleClass('o_we_overlay_sticky', show);
        }

        // Show/hide overlay in preview mode or not
        this.$el.toggleClass('oe_active', show);
        this.cover();
    },
    /**
     * Displays/Hides the editor (+ parent) options and call onFocus/onBlur if
     * necessary.
     *
     * @param {boolean} show
     * @returns {Promise}
     */
    async toggleOptions(show) {
        if (!this.$el) {
            return;
        }

        if (this.areOptionsShown() === show) {
            return;
        }
        // TODO should update the panel after the items have been updated
        this.trigger_up('update_customize_elements', {
            customize$Elements: show ? this._customize$Elements : [],
        });
        // All onFocus before all ui updates as the onFocus of an option might
        // affect another option (like updating the $target)
        const editorUIsToUpdate = [];
        const focusOrBlur = show
            ? (editor, options) => {
                for (const opt of options) {
                    opt.onFocus();
                }
                editorUIsToUpdate.push(editor);
            }
            : (editor, options) => {
                for (const opt of options) {
                    opt.onBlur();
                }
            };
        for (const $el of this._customize$Elements) {
            const editor = $el.data('editor');
            const styles = _.chain(editor.styles)
                .values()
                .sortBy('__order')
                .value();
            // TODO ideally: allow async parts in onFocus/onBlur
            focusOrBlur(editor, styles);
        }
        await Promise.all(editorUIsToUpdate.map(editor => editor.updateOptionsUI()));
        await Promise.all(editorUIsToUpdate.map(editor => editor.updateOptionsUIVisibility()));
    },
    /**
     * @param {boolean} [show]
     * @returns {Promise<boolean>}
     */
    toggleTargetVisibility: async function (show) {
        show = this._toggleVisibilityStatus(show);
        var styles = _.values(this.styles);
        const proms = _.sortBy(styles, '__order').map(style => {
            return show ? style.onTargetShow() : style.onTargetHide();
        });
        await Promise.all(proms);
        return show;
    },
    /**
     * @param {boolean} [show=false]
     */
    toggleOverlayVisibility: function (show) {
        if (this.$el && !this.scrollingTimeout) {
            this.$el.toggleClass('o_overlay_hidden', !show && this.isShown());
        }
    },
    /**
     * Updates the UI of all the options according to the status of their
     * associated editable DOM. This does not take care of options *visibility*.
     * For that @see updateOptionsUIVisibility, which should called when the UI
     * is up-to-date thanks to the function here, as the visibility depends on
     * the UI's status.
     *
     * @returns {Promise}
     */
    async updateOptionsUI() {
        const proms = Object.values(this.styles).map(opt => {
            return opt.updateUI({noVisibility: true});
        });
        return Promise.all(proms);
    },
    /**
     * Updates the visibility of the UI of all the options according to the
     * status of their associated dependencies and related editable DOM status.
     *
     * @returns {Promise}
     */
    async updateOptionsUIVisibility() {
        const proms = Object.values(this.styles).map(opt => {
            return opt.updateUIVisibility();
        });
        return Promise.all(proms);
    },
    /**
     * Clones the current snippet.
     *
     * @private
     * @param {boolean} recordUndo
     */
    clone: async function (recordUndo) {
        this.trigger_up('snippet_will_be_cloned', {$target: this.$target});

        var $clone = this.$target.clone(false);

        if (recordUndo) {
            this.trigger_up('request_history_undo_record', {$target: this.$target});
        }

        this.$target.after($clone);
        await new Promise(resolve => {
            this.trigger_up('call_for_each_child_snippet', {
                $snippet: $clone,
                callback: function (editor, $snippet) {
                    for (var i in editor.styles) {
                        editor.styles[i].onClone({
                            isCurrent: ($snippet.is($clone)),
                        });
                    }
                },
                onSuccess: resolve,
            });
        });
        this.trigger_up('snippet_cloned', {$target: $clone, $origin: this.$target});

        $clone.trigger('content_changed');
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Instantiates the snippet's options.
     *
     * @private
     */
    _initializeOptions: function () {
        this._customize$Elements = [];
        this.styles = {};
        this.selectorSiblings = [];
        this.selectorChildren = [];

        var $element = this.$target.parent();
        while ($element.length) {
            var parentEditor = $element.data('snippet-editor');
            if (parentEditor) {
                this._customize$Elements = this._customize$Elements
                    .concat(parentEditor._customize$Elements);
                break;
            }
            $element = $element.parent();
        }

        var $optionsSection = $(core.qweb.render('web_editor.customize_block_options_section', {
            name: this.getName(),
        })).data('editor', this);
        const $optionsSectionBtnGroup = $optionsSection.find('we-top-button-group');
        $optionsSectionBtnGroup.contents().each((i, node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                node.parentNode.removeChild(node);
            }
        });
        $optionsSection.on('mouseenter', this._onOptionsSectionMouseEnter.bind(this));
        $optionsSection.on('mouseleave', this._onOptionsSectionMouseLeave.bind(this));
        $optionsSection.on('click', 'we-title > span', this._onOptionsSectionClick.bind(this));
        $optionsSection.on('click', '.oe_snippet_clone', this._onCloneClick.bind(this));
        $optionsSection.on('click', '.oe_snippet_remove', this._onRemoveClick.bind(this));
        this._customize$Elements.push($optionsSection);

        // TODO get rid of this when possible (made as a fix to support old
        // theme options)
        this.$el.data('$optionsSection', $optionsSection);

        var i = 0;
        var defs = _.map(this.templateOptions, val => {
            if (!val.selector.is(this.$target)) {
                return;
            }
            if (val['drop-near']) {
                this.selectorSiblings.push(val['drop-near']);
            }
            if (val['drop-in']) {
                this.selectorChildren.push(val['drop-in']);
            }

            var optionName = val.option;
            var option = new (options.registry[optionName] || options.Class)(
                this,
                val.$el.children(),
                val.base_target ? this.$target.find(val.base_target).eq(0) : this.$target,
                this.$el,
                _.extend({
                    optionName: optionName,
                    snippetName: this.getName(),
                }, val.data),
                this.options
            );
            var key = optionName || _.uniqueId('option');
            if (this.styles[key]) {
                // If two snippet options use the same option name (and so use
                // the same JS option), store the subsequent ones with a unique
                // ID (TODO improve)
                key = _.uniqueId(key);
            }
            this.styles[key] = option;
            option.__order = i++;

            if (option.forceNoDeleteButton) {
                this.$el.add($optionsSection).find('.oe_snippet_remove').addClass('d-none');
            }

            return option.appendTo(document.createDocumentFragment());
        });

        this.isTargetMovable = (this.selectorSiblings.length > 0 || this.selectorChildren.length > 0);

        this.$el.find('[data-toggle="dropdown"]').dropdown();

        return Promise.all(defs).then(() => {
            const options = _.sortBy(this.styles, '__order');
            options.forEach(option => {
                if (option.isTopOption) {
                    $optionsSectionBtnGroup.prepend(option.$el);
                } else {
                    $optionsSection.append(option.$el);
                }
            });
            $optionsSection.toggleClass('d-none', options.length === 0);
        });
    },
    /**
     * @private
     * @param {boolean} [show]
     */
    _toggleVisibilityStatus: function (show) {
        if (show === undefined) {
            show = !this.isTargetVisible();
        }
        if (show) {
            delete this.$target[0].dataset.invisible;
        } else {
            this.$target[0].dataset.invisible = '1';
        }
        return show;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Called when the 'clone' button is clicked.
     *
     * @private
     * @param {Event} ev
     */
    _onCloneClick: function (ev) {
        ev.preventDefault();
        this.clone(true);
    },
    /**
     * Called when the snippet is starting to be dragged thanks to the 'move'
     * button.
     *
     * @private
     */
    _onDragAndDropStart: function () {
        var self = this;
        this.dropped = false;
        self.size = {
            width: self.$target.width(),
            height: self.$target.height()
        };
        self.$target.after('<div class="oe_drop_clone" style="display: none;"/>');
        self.$target.detach();
        self.$el.addClass('d-none');

        var $selectorSiblings;
        for (var i = 0; i < self.selectorSiblings.length; i++) {
            if (!$selectorSiblings) {
                $selectorSiblings = self.selectorSiblings[i].all();
            } else {
                $selectorSiblings = $selectorSiblings.add(self.selectorSiblings[i].all());
            }
        }
        var $selectorChildren;
        for (i = 0; i < self.selectorChildren.length; i++) {
            if (!$selectorChildren) {
                $selectorChildren = self.selectorChildren[i].all();
            } else {
                $selectorChildren = $selectorChildren.add(self.selectorChildren[i].all());
            }
        }

        this.trigger_up('go_to_parent', {$snippet: this.$target});
        this.trigger_up('activate_insertion_zones', {
            $selectorSiblings: $selectorSiblings,
            $selectorChildren: $selectorChildren,
        });

        this.$body.addClass('move-important');

        this.$editable.find('.oe_drop_zone').droppable({
            over: function () {
                if (self.dropped) {
                    self.$target.detach();
                    $('.oe_drop_zone').removeClass('invisible');
                }
                self.dropped = true;
                $(this).first().after(self.$target).addClass('invisible');
            },
            out: function () {
                var prev = self.$target.prev();
                if (this === prev[0]) {
                    self.dropped = false;
                    self.$target.detach();
                    $(this).removeClass('invisible');
                }
            },
        });

        // If a modal is open, the scroll target must be that modal
        const $openModal = self.$editable.find('.modal:visible');
        self.draggableComponent.$scrollTarget = $openModal.length ? $openModal : self.$scrollingElement;

        // Trigger a scroll on the draggable element so that jQuery updates
        // the position of the drop zones.
        self.draggableComponent.$scrollTarget.on('scroll.scrolling_element', function () {
            self.$el.trigger('scroll');
        });
    },
    /**
     * Called when the snippet is dropped after being dragged thanks to the
     * 'move' button.
     *
     * @private
     * @param {Event} ev
     * @param {Object} ui
     */
    _onDragAndDropStop: function (ev, ui) {
        // TODO lot of this is duplicated code of the d&d feature of snippets
        if (!this.dropped) {
            var $el = $.nearest({x: ui.position.left, y: ui.position.top}, '.oe_drop_zone', {container: document.body}).first();
            if ($el.length) {
                $el.after(this.$target);
                this.dropped = true;
            }
        }

        this.$editable.find('.oe_drop_zone').droppable('destroy').remove();

        var prev = this.$target.first()[0].previousSibling;
        var next = this.$target.last()[0].nextSibling;
        var $parent = this.$target.parent();

        var $clone = this.$editable.find('.oe_drop_clone');
        if (prev === $clone[0]) {
            prev = $clone[0].previousSibling;
        } else if (next === $clone[0]) {
            next = $clone[0].nextSibling;
        }
        $clone.after(this.$target);
        var $from = $clone.parent();

        this.$el.removeClass('d-none');
        this.$body.removeClass('move-important');
        $clone.remove();

        if (this.dropped) {
            this.trigger_up('request_history_undo_record', {$target: this.$target});

            if (prev) {
                this.$target.insertAfter(prev);
            } else if (next) {
                this.$target.insertBefore(next);
            } else {
                $parent.prepend(this.$target);
            }

            for (var i in this.styles) {
                this.styles[i].onMove();
            }

            this.$target.trigger('content_changed');
            $from.trigger('content_changed');
        }

        this.trigger_up('drag_and_drop_stop', {
            $snippet: this.$target,
        });
        this.draggableComponent.$scrollTarget.off('scroll.scrolling_element');
    },
    /**
     * @private
     */
    _onOptionsSectionMouseEnter: function (ev) {
        if (!this.$target.is(':visible')) {
            return;
        }
        this.trigger_up('activate_snippet', {
            $snippet: this.$target,
            previewMode: true,
        });
    },
    /**
     * @private
     */
    _onOptionsSectionMouseLeave: function (ev) {
        this.trigger_up('activate_snippet', {
            $snippet: false,
            previewMode: true,
        });
    },
    /**
     * @private
     */
    _onOptionsSectionClick: function (ev) {
        this.trigger_up('activate_snippet', {
            $snippet: this.$target,
            previewMode: false,
        });
    },
    /**
     * Called when a child editor/option asks for another option to perform a
     * specific action/react to a specific event.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onOptionUpdate: function (ev) {
        var self = this;

        // If multiple option names are given, we suppose it should not be
        // propagated to parent editor
        if (ev.data.optionNames) {
            ev.stopPropagation();
            _.each(ev.data.optionNames, function (name) {
                notifyForEachMatchedOption(name);
            });
        }
        // If one option name is given, we suppose it should be handle by the
        // first parent editor which can do it
        if (ev.data.optionName) {
            if (notifyForEachMatchedOption(ev.data.optionName)) {
                ev.stopPropagation();
            }
        }

        function notifyForEachMatchedOption(name) {
            var regex = new RegExp('^' + name + '\\d+$');
            var hasOption = false;
            for (var key in self.styles) {
                if (key === name || regex.test(key)) {
                    self.styles[key].notify(ev.data.name, ev.data.data);
                    hasOption = true;
                }
            }
            return hasOption;
        }
    },
    /**
     * Called when the 'remove' button is clicked.
     *
     * @private
     * @param {Event} ev
     */
    _onRemoveClick: function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        this.trigger_up('request_history_undo_record', {$target: this.$target});
        this.removeSnippet();
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onSnippetOptionUpdate: async function (ev) {
        // TODO remove me in master
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onSnippetOptionVisibilityUpdate: function (ev) {
        ev.data.show = this._toggleVisibilityStatus(ev.data.show);
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onUserValueWidgetRequest: function (ev) {
        ev.stopPropagation();
        for (const key of Object.keys(this.styles)) {
            const widget = this.styles[key].findWidget(ev.data.name);
            if (widget) {
                ev.data.onSuccess(widget);
                return;
            }
        }
    },
    /**
     * Called when the 'mouse wheel' is used when hovering over the overlay.
     * Disable the pointer events to prevent page scrolling from stopping.
     *
     * @private
     * @param {Event} ev
     */
    _onMouseWheel: function (ev) {
        ev.stopPropagation();
        this.$el.css('pointer-events', 'none');
        clearTimeout(this.wheelTimeout);
        this.wheelTimeout = setTimeout(() => {
            this.$el.css('pointer-events', '');
        }, 250);
    },
});

/**
 * Management of drag&drop menu and snippet related behaviors in the page.
 */
var SnippetsMenu = Widget.extend({
    id: 'oe_snippets',
    cacheSnippetTemplate: {},
    events: {
        'click .oe_snippet': '_onSnippetClick',
        'click .o_install_btn': '_onInstallBtnClick',
        'click .o_we_add_snippet_btn': '_onBlocksTabClick',
        'click .o_we_invisible_entry': '_onInvisibleEntryClick',
        'click #snippet_custom .o_delete_btn': '_onDeleteBtnClick',
        'mousedown': '_onMouseDown',
        'input .o_snippet_search_filter_input': '_onSnippetSearchInput',
        'click .o_snippet_search_filter_reset': '_onSnippetSearchResetClick',
        'summernote_popover_update_call .o_we_snippet_text_tools': '_onSummernoteToolsUpdate',
    },
    custom_events: {
        'activate_insertion_zones': '_onActivateInsertionZones',
        'activate_snippet': '_onActivateSnippet',
        'call_for_each_child_snippet': '_onCallForEachChildSnippet',
        'clone_snippet': '_onCloneSnippet',
        'cover_update': '_onOverlaysCoverUpdate',
        'deactivate_snippet': '_onDeactivateSnippet',
        'drag_and_drop_stop': '_onDragAndDropStop',
        'get_snippet_versions': '_onGetSnippetVersions',
        'go_to_parent': '_onGoToParent',
        'remove_snippet': '_onRemoveSnippet',
        'snippet_edition_request': '_onSnippetEditionRequest',
        'snippet_editor_destroyed': '_onSnippetEditorDestroyed',
        'snippet_removed': '_onSnippetRemoved',
        'snippet_cloned': '_onSnippetCloned',
        'snippet_option_update': '_onSnippetOptionUpdate',
        'snippet_option_visibility_update': '_onSnippetOptionVisibilityUpdate',
        'snippet_thumbnail_url_request': '_onSnippetThumbnailURLRequest',
        'reload_snippet_dropzones': '_disableUndroppableSnippets',
        'request_save': '_onSaveRequest',
        'update_customize_elements': '_onUpdateCustomizeElements',
        'hide_overlay': '_onHideOverlay',
        'block_preview_overlays': '_onBlockPreviewOverlays',
        'unblock_preview_overlays': '_onUnblockPreviewOverlays',
        'user_value_widget_opening': '_onUserValueWidgetOpening',
        'user_value_widget_closing': '_onUserValueWidgetClosing',
        'reload_snippet_template': '_onReloadSnippetTemplate',
    },
    // enum of the SnippetsMenu's tabs.
    tabs: {
        BLOCKS: 'blocks',
        OPTIONS: 'options',
    },

    /**
     * @param {Widget} parent
     * @param {Object} [options]
     * @param {string} [options.snippets]
     *      URL of the snippets template. This URL might have been set
     *      in the global 'snippets' variable, otherwise this function
     *      assigns a default one.
     *      default: 'web_editor.snippets'
     *
     * @constructor
     */
    init: function (parent, options) {
        this._super.apply(this, arguments);
        options = options || {};
        this.trigger_up('getRecordInfo', {
            recordInfo: options,
            callback: function (recordInfo) {
                _.defaults(options, recordInfo);
            },
        });

        this.options = options;
        if (!this.options.snippets) {
            this.options.snippets = 'web_editor.snippets';
        }
        this.snippetEditors = [];
        this._enabledEditorHierarchy = [];

        this._mutex = new concurrency.Mutex();

        this.setSelectorEditableArea(options.$el, options.selectorEditableArea);

        this._notActivableElementsSelector = [
            '#web_editor-top-edit',
            '.o_we_website_top_actions',
            '#oe_snippets',
            '#oe_manipulators',
            '.o_technical_modal',
            '.oe_drop_zone',
            '.o_notification_manager',
            '.o_we_no_overlay',
            '.ui-autocomplete',
            '.modal .close',
            '.o_we_crop_widget',
        ].join(', ');

        this.loadingTimers = {};
        this.loadingElements = {};
    },
    /**
     * @override
     */
    willStart: function () {
        // Preload colorpalette dependencies without waiting for them. The
        // widget have huge chances of being used by the user (clicking on any
        // text will load it). The colorpalette itself will do the actual
        // waiting of the loading completion.
        ColorPaletteWidget.loadDependencies(this);
        return this._super(...arguments);
    },
    /**
     * @override
     */
    async start() {
        var defs = [this._super.apply(this, arguments)];
        this.ownerDocument = this.$el[0].ownerDocument;
        this.$document = $(this.ownerDocument);
        this.window = this.ownerDocument.defaultView;
        this.$window = $(this.window);

        this.customizePanel = document.createElement('div');
        this.customizePanel.classList.add('o_we_customize_panel', 'd-none');

        this.textEditorPanelEl = document.createElement('div');
        this.textEditorPanelEl.classList.add('o_we_snippet_text_tools', 'd-none');

        this.invisibleDOMPanelEl = document.createElement('div');
        this.invisibleDOMPanelEl.classList.add('o_we_invisible_el_panel');
        this.invisibleDOMPanelEl.appendChild(
            $('<div/>', {
                text: _t('Invisible Elements'),
                class: 'o_panel_header',
            })[0]
        );

        this.options.getScrollOptions = this._getScrollOptions.bind(this);

        // Fetch snippet templates and compute it
        defs.push((async () => {
            await this._loadSnippetsTemplates();
            await this._updateInvisibleDOM();
        })());

        // Prepare snippets editor environment
        this.$snippetEditorArea = $('<div/>', {
            id: 'oe_manipulators',
        }).insertAfter(this.$el);

        // Active snippet editor on click in the page
        var lastElement;
        const onClick = ev => {
            var srcElement = ev.target || (ev.originalEvent && (ev.originalEvent.target || ev.originalEvent.originalTarget)) || ev.srcElement;
            if (!srcElement || lastElement === srcElement) {
                return;
            }
            lastElement = srcElement;
            _.defer(function () {
                lastElement = false;
            });

            var $target = $(srcElement);
            if (!$target.closest('we-button, we-toggler, we-select, .o_we_color_preview').length) {
                this._closeWidgets();
            }
            if (!$target.closest('body > *').length) {
                return;
            }
            if ($target.closest(this._notActivableElementsSelector).length) {
                return;
            }
            const $oeStructure = $target.closest('.oe_structure');
            if ($oeStructure.length && !$oeStructure.children().length && this.$snippets) {
                // If empty oe_structure, encourage using snippets in there by
                // making them "wizz" in the panel.
                this.$snippets.odooBounce();
                return;
            }
            this._activateSnippet($target);
        };

        this.$document.on('click.snippets_menu', '*', onClick);
        // Needed as bootstrap stop the propagation of click events for dropdowns
        this.$document.on('mouseup.snippets_menu', '.dropdown-toggle', onClick);

        core.bus.on('deactivate_snippet', this, this._onDeactivateSnippet);

        // Adapt overlay covering when the window is resized / content changes
        var debouncedCoverUpdate = _.throttle(() => {
            this.updateCurrentSnippetEditorOverlay();
        }, 50);
        this.$window.on('resize.snippets_menu', debouncedCoverUpdate);
        this.$window.on('content_changed.snippets_menu', debouncedCoverUpdate);

        // On keydown add a class on the active overlay to hide it and show it
        // again when the mouse moves
        this.$document.on('keydown.snippets_menu', () => {
            this.__overlayKeyWasDown = true;
            this.snippetEditors.forEach(editor => {
                editor.toggleOverlayVisibility(false);
            });
        });
        this.$document.on('mousemove.snippets_menu, mousedown.snippets_menu', _.throttle(() => {
            if (!this.__overlayKeyWasDown) {
                return;
            }
            this.__overlayKeyWasDown = false;
            this.snippetEditors.forEach(editor => {
                editor.toggleOverlayVisibility(true);
                editor.cover();
            });
        }, 250));

        // Hide the active overlay when scrolling.
        // Show it again and recompute all the overlays after the scroll.
        this.$scrollingElement = $().getScrollingElement();
        this._onScrollingElementScroll = _.throttle(() => {
            for (const editor of this.snippetEditors) {
                editor.toggleOverlayVisibility(false);
            }
            clearTimeout(this.scrollingTimeout);
            this.scrollingTimeout = setTimeout(() => {
                this._scrollingTimeout = null;
                for (const editor of this.snippetEditors) {
                    editor.toggleOverlayVisibility(true);
                    editor.cover();
                }
            }, 250);
        }, 50);
        // We use addEventListener instead of jQuery because we need 'capture'.
        // Setting capture to true allows to take advantage of event bubbling
        // for events that otherwise don’t support it. (e.g. useful when
        // scrolling a modal)
        this.$scrollingElement[0].addEventListener('scroll', this._onScrollingElementScroll, {capture: true});

        // Auto-selects text elements with a specific class and remove this
        // on text changes
        this.$document.on('click.snippets_menu', '.o_default_snippet_text', function (ev) {
            $(ev.target).closest('.o_default_snippet_text').removeClass('o_default_snippet_text');
            $(ev.target).selectContent();
            $(ev.target).removeClass('o_default_snippet_text');
        });
        this.$document.on('keyup.snippets_menu', function () {
            var range = Wysiwyg.getRange(this);
            $(range && range.sc).closest('.o_default_snippet_text').removeClass('o_default_snippet_text');
        });

        const $autoFocusEls = $('.o_we_snippet_autofocus');
        this._activateSnippet($autoFocusEls.length ? $autoFocusEls.first() : false);

        // Add tooltips on we-title elements whose text overflows
        this.$el.tooltip({
            selector: 'we-title',
            placement: 'bottom',
            delay: 100,
            title: function () {
                const el = this;
                // On Firefox, el.scrollWidth is equal to el.clientWidth when
                // overflow: hidden, so we need to update the style before to
                // get the right values.
                el.style.setProperty('overflow', 'scroll', 'important');
                const tipContent = el.scrollWidth > el.clientWidth ? el.innerHTML : '';
                el.style.removeProperty('overflow');
                return tipContent;
            },
        });

        return Promise.all(defs).then(() => {
            this.$('[data-title]').tooltip({
                delay: 100,
                title: function () {
                    return this.classList.contains('active') ? false : this.dataset.title;
                },
            });

            // Trigger a resize event once entering edit mode as the snippets
            // menu will take part of the screen width (delayed because of
            // animation). (TODO wait for real animation end)
            setTimeout(() => {
                this.$window.trigger('resize');

                // Hacky way to prevent to switch to text tools on editor
                // start. Only allow switching after some delay. Switching to
                // tools is only useful for out-of-snippet texts anyway, so
                // snippet texts can still be enabled immediately.
                this._mutex.exec(() => this._textToolsSwitchingEnabled = true);
            }, 1000);
        });
    },
    /**
     * @override
     */
    destroy: function () {
        this._super.apply(this, arguments);
        if (this.$window) {
            this.$snippetEditorArea.remove();
            this.$window.off('.snippets_menu');
            this.$document.off('.snippets_menu');
            this.$scrollingElement[0].removeEventListener('scroll', this._onScrollingElementScroll, {capture: true});
        }
        core.bus.off('deactivate_snippet', this, this._onDeactivateSnippet);
        delete this.cacheSnippetTemplate[this.options.snippets];
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Prepares the page so that it may be saved:
     * - Asks the snippet editors to clean their associated snippet
     * - Remove the 'contentEditable' attributes
     */
    cleanForSave: async function () {
        // First disable the snippet selection, calling options onBlur, closing
        // widgets, etc. Then wait for full resolution of the mutex as widgets
        // may have triggered some final edition requests that need to be
        // processed before actual "clean for save" and saving.
        await this._activateSnippet(false);
        await this._mutex.getUnlockedDef();

        // Next, notify that we want the DOM to be cleaned (e.g. in website this
        // may be the moment where the public widgets need to be destroyed).
        this.trigger_up('ready_to_clean_for_save');

        // Then destroy all snippet editors, making them call their own
        // "clean for save" methods (and options ones).
        await this._destroyEditors();

        // Final editor cleanup
        this.getEditableArea().find('[contentEditable]')
            .removeAttr('contentEditable')
            .removeProp('contentEditable');
        this.getEditableArea().find('.o_we_selected_image')
            .removeClass('o_we_selected_image');
    },
    /**
     * Load snippets.
     * @param {boolean} invalidateCache
     */
    loadSnippets: function (invalidateCache) {
        if (!invalidateCache && this.cacheSnippetTemplate[this.options.snippets]) {
            this._defLoadSnippets = this.cacheSnippetTemplate[this.options.snippets];
            return this._defLoadSnippets;
        }
        this._defLoadSnippets = this._rpc({
            model: 'ir.ui.view',
            method: 'render_public_asset',
            args: [this.options.snippets, {}],
            kwargs: {
                context: this.options.context,
            },
        });
        this.cacheSnippetTemplate[this.options.snippets] = this._defLoadSnippets;
        return this._defLoadSnippets;
    },
    /**
     * Sets the instance variables $editor, $body and selectorEditableArea.
     *
     * @param {JQuery} $editor
     * @param {String} selectorEditableArea
     */
    setSelectorEditableArea: function ($editor, selectorEditableArea) {
        this.selectorEditableArea = selectorEditableArea;
        this.$editor = $editor;
        this.$body = $editor.closest('body');
    },
    /**
     * Get the editable area.
     *
     * @returns {JQuery}
     */
    getEditableArea: function () {
        return this.$editor.find(this.selectorEditableArea)
            .add(this.$editor.filter(this.selectorEditableArea));
    },
    /**
     * Updates the cover dimensions of the current snippet editor.
     */
    updateCurrentSnippetEditorOverlay: function () {
        for (const snippetEditor of this.snippetEditors) {
            if (snippetEditor.$target.closest('body').length) {
                snippetEditor.cover();
                continue;
            }
            // Destroy options whose $target are not in the DOM anymore but
            // only do it once all options executions are done.
            this._mutex.exec(() => snippetEditor.destroy());
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Creates drop zones in the DOM (locations where snippets may be dropped).
     * Those locations are determined thanks to the two types of given DOM.
     *
     * @private
     * @param {jQuery} [$selectorSiblings]
     *        elements which must have siblings drop zones
     * @param {jQuery} [$selectorChildren]
     *        elements which must have child drop zones between each of existing
     *        child
     */
    _activateInsertionZones: function ($selectorSiblings, $selectorChildren) {
        var self = this;

        // If a modal or a dropdown is open, the drop zones must be created
        // only in this element.
        const $editableArea = self.getEditableArea();
        let $open = $editableArea.find('.modal:visible');
        if (!$open.length) {
            $open = $editableArea.find('.dropdown-menu.show').addBack('.dropdown-menu.show').parent();
        }
        if ($open.length) {
            $selectorSiblings = $open.find($selectorSiblings);
            $selectorChildren = $open.find($selectorChildren);
        }

        // Check if the drop zone should be horizontal or vertical
        function setDropZoneDirection($elem, $parent, $sibling) {
            var vertical = false;
            var style = {};
            $sibling = $sibling || $elem;
            var css = window.getComputedStyle($elem[0]);
            var parentCss = window.getComputedStyle($parent[0]);
            var float = css.float || css.cssFloat;
            var display = parentCss.display;
            var flex = parentCss.flexDirection;
            if (float === 'left' || float === 'right' || (display === 'flex' && flex === 'row')) {
                style['float'] = float;
                if ($sibling.parent().width() !== $sibling.outerWidth(true)) {
                    vertical = true;
                    style['height'] = Math.max($sibling.outerHeight(), 30) + 'px';
                }
            }
            return {
                vertical: vertical,
                style: style,
            };
        }

        // If the previous sibling is a BR tag or a non-whitespace text, it
        // should be a vertical dropzone.
        function testPreviousSibling(node, $zone) {
            if (!node || ((node.tagName || !node.textContent.match(/\S/)) && node.tagName !== 'BR')) {
                return false;
            }
            return {
                vertical: true,
                style: {
                    'float': 'none',
                    'display': 'inline-block',
                    'height': parseInt(self.window.getComputedStyle($zone[0]).lineHeight) + 'px',
                },
            };
        }

        // Firstly, add a dropzone after the clone
        var $clone = $('.oe_drop_clone');
        if ($clone.length) {
            var $neighbor = $clone.prev();
            if (!$neighbor.length) {
                $neighbor = $clone.next();
            }
            var data;
            if ($neighbor.length) {
                data = setDropZoneDirection($neighbor, $neighbor.parent());
            } else {
                data = {
                    vertical: false,
                    style: {},
                };
            }
            self._insertDropzone($('<we-hook/>').insertAfter($clone), data.vertical, data.style);
        }

        if ($selectorChildren) {
            $selectorChildren.each(function () {
                var data;
                var $zone = $(this);
                var $children = $zone.find('> :not(.oe_drop_zone, .oe_drop_clone)');

                if (!$zone.children().last().is('.oe_drop_zone')) {
                    data = testPreviousSibling($zone[0].lastChild, $zone)
                        || setDropZoneDirection($zone, $zone, $children.last());
                    self._insertDropzone($('<we-hook/>').appendTo($zone), data.vertical, data.style);
                }

                if (!$zone.children().first().is('.oe_drop_clone')) {
                    data = testPreviousSibling($zone[0].firstChild, $zone)
                        || setDropZoneDirection($zone, $zone, $children.first());
                    self._insertDropzone($('<we-hook/>').prependTo($zone), data.vertical, data.style);
                }
            });

            // add children near drop zone
            $selectorSiblings = $(_.uniq(($selectorSiblings || $()).add($selectorChildren.children()).get()));
        }

        var noDropZonesSelector = '[data-invisible="1"], .o_we_no_overlay, :not(:visible)';
        if ($selectorSiblings) {
            $selectorSiblings.not(`.oe_drop_zone, .oe_drop_clone, ${noDropZonesSelector}`).each(function () {
                var data;
                var $zone = $(this);
                var $zoneToCheck = $zone;

                while ($zoneToCheck.prev(noDropZonesSelector).length) {
                    $zoneToCheck = $zoneToCheck.prev();
                }
                if (!$zoneToCheck.prev('.oe_drop_zone:visible, .oe_drop_clone').length) {
                    data = setDropZoneDirection($zone, $zone.parent());
                    self._insertDropzone($('<we-hook/>').insertBefore($zone), data.vertical, data.style);
                }

                $zoneToCheck = $zone;
                while ($zoneToCheck.next(noDropZonesSelector).length) {
                    $zoneToCheck = $zoneToCheck.next();
                }
                if (!$zoneToCheck.next('.oe_drop_zone:visible, .oe_drop_clone').length) {
                    data = setDropZoneDirection($zone, $zone.parent());
                    self._insertDropzone($('<we-hook/>').insertAfter($zone), data.vertical, data.style);
                }
            });
        }

        var count;
        var $zones;
        do {
            count = 0;
            $zones = this.getEditableArea().find('.oe_drop_zone > .oe_drop_zone').remove(); // no recursive zones
            count += $zones.length;
            $zones.remove();
        } while (count > 0);

        // Cleaning consecutive zone and up zones placed between floating or
        // inline elements. We do not like these kind of zones.
        $zones = this.getEditableArea().find('.oe_drop_zone:not(.oe_vertical)');
        $zones.each(function () {
            var zone = $(this);
            var prev = zone.prev();
            var next = zone.next();
            // remove consecutive zone
            if (prev.is('.oe_drop_zone') || next.is('.oe_drop_zone')) {
                zone.remove();
                return;
            }
            var floatPrev = prev.css('float') || 'none';
            var floatNext = next.css('float') || 'none';
            var dispPrev = prev.css('display') || null;
            var dispNext = next.css('display') || null;
            if ((floatPrev === 'left' || floatPrev === 'right')
             && (floatNext === 'left' || floatNext === 'right')) {
                zone.remove();
            } else if (dispPrev !== null && dispNext !== null
             && dispPrev.indexOf('inline') >= 0 && dispNext.indexOf('inline') >= 0) {
                zone.remove();
            }
        });
    },
    /**
     * Adds an entry for every invisible snippet in the left panel box.
     * The entries will contains an 'Edit' button to activate their snippet.
     *
     * @private
     * @returns {Promise}
     */
    _updateInvisibleDOM: function () {
        return this._execWithLoadingEffect(() => {
            this.invisibleDOMMap = new Map();
            const $invisibleDOMPanelEl = $(this.invisibleDOMPanelEl);
            $invisibleDOMPanelEl.find('.o_we_invisible_entry').remove();
            const $invisibleSnippets = globalSelector.all().find('.o_snippet_invisible').addBack('.o_snippet_invisible');

            $invisibleDOMPanelEl.toggleClass('d-none', !$invisibleSnippets.length);

            const proms = _.map($invisibleSnippets, async el => {
                const editor = await this._createSnippetEditor($(el));
                const $invisEntry = $('<div/>', {
                    class: 'o_we_invisible_entry d-flex align-items-center justify-content-between',
                    text: editor.getName(),
                }).append($('<i/>', {class: `fa ${editor.isTargetVisible() ? 'fa-eye' : 'fa-eye-slash'} ml-2`}));
                $invisibleDOMPanelEl.append($invisEntry);
                this.invisibleDOMMap.set($invisEntry[0], el);
            });
            return Promise.all(proms);
        }, false);
    },
    /**
     * Disable the overlay editor of the active snippet and activate the new one
     * if given.
     * Note 1: if the snippet editor associated to the given snippet is not
     *         created yet, this method will create it.
     * Note 2: if the given DOM element is not a snippet (no editor option), the
     *         first parent which is one is used instead.
     *
     * @param {jQuery|false} $snippet
     *        The DOM element whose editor (and its parent ones) need to be
     *        enabled. Only disable the current one if false is given.
     * @param {boolean} [previewMode=false]
     * @param {boolean} [ifInactiveOptions=false]
     * @returns {Promise<SnippetEditor>}
     *          (might be async when an editor must be created)
     */
    _activateSnippet: async function ($snippet, previewMode, ifInactiveOptions) {
        if (this._blockPreviewOverlays && previewMode) {
            return;
        }
        if ($snippet && !$snippet.is(':visible')) {
            return;
        }
        // Take the first parent of the provided DOM (or itself) which
        // should have an associated snippet editor.
        // It is important to do that before the mutex exec call to compute it
        // before potential ancestor removal.
        if ($snippet && $snippet.length) {
            $snippet = globalSelector.closest($snippet);
        }
        const exec = previewMode
            ? action => this._mutex.exec(action)
            : action => this._execWithLoadingEffect(action, false);
        return exec(() => {
            return new Promise(resolve => {
                if ($snippet && $snippet.length) {
                    return this._createSnippetEditor($snippet).then(resolve);
                }
                resolve(null);
            }).then(async editorToEnable => {
                if (!previewMode && this._enabledEditorHierarchy[0] === editorToEnable
                        || ifInactiveOptions && this._enabledEditorHierarchy.includes(editorToEnable)) {
                    return editorToEnable;
                }

                if (!previewMode) {
                    this._enabledEditorHierarchy = [];
                    let current = editorToEnable;
                    while (current && current.$target) {
                        this._enabledEditorHierarchy.push(current);
                        current = current.getParent();
                    }
                }

                // First disable all editors...
                for (let i = this.snippetEditors.length; i--;) {
                    const editor = this.snippetEditors[i];
                    editor.toggleOverlay(false, previewMode);
                    if (!previewMode) {
                        await editor.toggleOptions(false);
                    }
                }
                // ... if no editors are to be enabled, look if any have been
                // enabled previously by a click
                if (!editorToEnable) {
                     editorToEnable = this.snippetEditors.find(editor => editor.isSticky());
                     previewMode = false;
                }
                // ... then enable the right editor
                if (editorToEnable) {
                    editorToEnable.toggleOverlay(true, previewMode);
                    await editorToEnable.toggleOptions(true);
                }

                return editorToEnable;
            });
        });
    },
    /**
     * @private
     * @param {boolean} invalidateCache
     */
    _loadSnippetsTemplates: async function (invalidateCache) {
        return this._execWithLoadingEffect(async () => {
            await this._destroyEditors();
            const html = await this.loadSnippets(invalidateCache);
            await this._computeSnippetTemplates(html);
        }, false);
    },
    /**
     * @private
     * @param {jQuery|null|undefined} [$el]
     *        The DOM element whose inside editors need to be destroyed.
     *        If no element is given, all the editors are destroyed.
     */
    _destroyEditors: async function ($el) {
        const proms = _.map(this.snippetEditors, async function (snippetEditor) {
            if ($el && !$el.has(snippetEditor.$target).length) {
                return;
            }
            await snippetEditor.cleanForSave();
            snippetEditor.destroy();
        });
        await Promise.all(proms);
        this.snippetEditors.splice(0);
    },
    /**
     * Calls a given callback 'on' the given snippet and all its child ones if
     * any (DOM element with options).
     *
     * Note: the method creates the snippet editors if they do not exist yet.
     *
     * @private
     * @param {jQuery} $snippet
     * @param {function} callback
     *        Given two arguments: the snippet editor associated to the snippet
     *        being managed and the DOM element of this snippet.
     * @returns {Promise} (might be async if snippet editors need to be created
     *                     and/or the callback is async)
     */
    _callForEachChildSnippet: function ($snippet, callback) {
        var self = this;
        var defs = _.map($snippet.add(globalSelector.all($snippet)), function (el) {
            var $snippet = $(el);
            return self._createSnippetEditor($snippet).then(function (editor) {
                if (editor) {
                    return callback.call(self, editor, $snippet);
                }
            });
        });
        return Promise.all(defs);
    },
    /**
     * @private
     */
    _closeWidgets: function () {
        this.snippetEditors.forEach(editor => editor.closeWidgets());
    },
    /**
     * Creates and returns a set of helper functions which can help finding
     * snippets in the DOM which match some parameters (typically parameters
     * given by a snippet option). The functions are:
     *
     * - `is`: to determine if a given DOM is a snippet that matches the
     *         parameters
     *
     * - `closest`: find closest parent (or itself) of a given DOM which is a
     *              snippet that matches the parameters
     *
     * - `all`: find all snippets in the DOM that match the parameters
     *
     * See implementation for function details.
     *
     * @private
     * @param {string} selector
     *        jQuery selector that DOM elements must match to be considered as
     *        potential snippet.
     * @param {string} exclude
     *        jQuery selector that DOM elements must *not* match to be
     *        considered as potential snippet.
     * @param {string|false} target
     *        jQuery selector that at least one child of a DOM element must
     *        match to that DOM element be considered as a potential snippet.
     * @param {boolean} noCheck
     *        true if DOM elements which are technically not in an editable
     *        environment may be considered.
     * @param {boolean} isChildren
     *        when the DOM elements must be in an editable environment to be
     *        considered (@see noCheck), this is true if the DOM elements'
     *        parent must also be in an editable environment to be considered.
     * @param {string} excludeParent
     *        jQuery selector that the parents of DOM elements must *not* match
     *        to be considered as potential snippet.
     */
    _computeSelectorFunctions: function (selector, exclude, target, noCheck, isChildren, excludeParent) {
        var self = this;

        exclude += `${exclude && ', '}.o_snippet_not_selectable`;

        let filterFunc = function () {
            return !$(this).is(exclude);
        };
        if (target) {
            const oldFilter = filterFunc;
            filterFunc = function () {
                return oldFilter.apply(this) && $(this).find(target).length !== 0;
            };
        }
        if (excludeParent) {
            const oldFilter = filterFunc;
            filterFunc = function () {
                return oldFilter.apply(this) && !$(this).parent().is(excludeParent);
            };
        }

        // Prepare the functions
        var functions = {
            is: function ($from) {
                return $from.is(selector) && $from.filter(filterFunc).length !== 0;
            },
        };
        if (noCheck) {
            functions.closest = function ($from, parentNode) {
                return $from.closest(selector, parentNode).filter(filterFunc);
            };
            functions.all = function ($from) {
                return ($from ? dom.cssFind($from, selector) : $(selector)).filter(filterFunc);
            };
        } else {
            functions.closest = function ($from, parentNode) {
                var parents = self.getEditableArea().get();
                return $from.closest(selector, parentNode).filter(function () {
                    var node = this;
                    while (node.parentNode) {
                        if (parents.indexOf(node) !== -1) {
                            return true;
                        }
                        node = node.parentNode;
                    }
                    return false;
                }).filter(filterFunc);
            };
            functions.all = isChildren ? function ($from) {
                return dom.cssFind($from || self.getEditableArea(), selector).filter(filterFunc);
            } : function ($from) {
                $from = $from || self.getEditableArea();
                return $from.filter(selector).add(dom.cssFind($from, selector)).filter(filterFunc);
            };
        }
        return functions;
    },
    /**
     * Processes the given snippet template to register snippet options, creates
     * draggable thumbnail, etc.
     *
     * @private
     * @param {string} html
     */
    _computeSnippetTemplates: function (html) {
        var self = this;
        var $html = $(html);
        var $scroll = $html.siblings('#o_scroll');

        // TODO remove me in master: introduced in a 14.0 fix to allow users to
        // customize their navbar with 'Boxed' website header, which they could
        // not because of a wrong XML selector they may not update.
        const $headerNavFix = $html.find('[data-js="HeaderNavbar"][data-selector="#wrapwrap > header > nav"]');
        if ($headerNavFix.length) {
            $headerNavFix[0].dataset.selector = '#wrapwrap > header nav.navbar';
        }

        this.templateOptions = [];
        var selectors = [];
        var $styles = $html.find('[data-selector]');
        const snippetAdditionDropIn = $styles.filter('#so_snippet_addition').data('drop-in');
        $styles.each(function () {
            var $style = $(this);
            var selector = $style.data('selector');
            var exclude = $style.data('exclude') || '';
            const excludeParent = $style.attr('id') === "so_content_addition" ? snippetAdditionDropIn : '';
            var target = $style.data('target');
            var noCheck = $style.data('no-check');
            var optionID = $style.data('js') || $style.data('option-name');  // used in tour js as selector
            var option = {
                'option': optionID,
                'base_selector': selector,
                'base_exclude': exclude,
                'base_target': target,
                'selector': self._computeSelectorFunctions(selector, exclude, target, noCheck),
                '$el': $style,
                'drop-near': $style.data('drop-near') && self._computeSelectorFunctions($style.data('drop-near'), '', false, noCheck, true, excludeParent),
                'drop-in': $style.data('drop-in') && self._computeSelectorFunctions($style.data('drop-in'), '', false, noCheck),
                'data': _.extend({string: $style.attr('string')}, $style.data()),
            };
            self.templateOptions.push(option);
            selectors.push(option.selector);
        });
        $styles.addClass('d-none');

        globalSelector.closest = function ($from) {
            var $temp;
            var $target;
            for (var i = 0, len = selectors.length; i < len; i++) {
                $temp = selectors[i].closest($from, $target && $target[0]);
                if ($temp.length) {
                    $target = $temp;
                }
            }
            return $target || $();
        };
        globalSelector.all = function ($from) {
            var $target = $();
            for (var i = 0, len = selectors.length; i < len; i++) {
                $target = $target.add(selectors[i].all($from));
            }
            return $target;
        };
        globalSelector.is = function ($from) {
            for (var i = 0, len = selectors.length; i < len; i++) {
                if (selectors[i].is($from)) {
                    return true;
                }
            }
            return false;
        };

        this.$snippets = $scroll.find('.o_panel_body').children()
            .addClass('oe_snippet')
            .each((i, el) => {
                const $snippet = $(el);
                const name = _.escape(el.getAttribute('name'));
                const thumbnailSrc = _.escape(el.dataset.oeThumbnail);
                const $sbody = $snippet.children().addClass('oe_snippet_body');
                const isCustomSnippet = !!el.closest('#snippet_custom');

                // Associate in-page snippets to their name
                // TODO I am not sure this is useful anymore and it should at
                // least be made more robust using data-snippet
                let snippetClasses = $sbody.attr('class').match(/s_[^ ]+/g);
                if (snippetClasses && snippetClasses.length) {
                    snippetClasses = '.' + snippetClasses.join('.');
                }
                const $els = $(snippetClasses).not('[data-name]').add($sbody);
                $els.attr('data-name', name).data('name', name);

                // Create the thumbnail
                const $thumbnail = $(`
                    <div class="oe_snippet_thumbnail">
                        <div class="oe_snippet_thumbnail_img" style="background-image: url(${thumbnailSrc});"/>
                        <span class="oe_snippet_thumbnail_title">${name}</span>
                    </div>
                `);
                $snippet.prepend($thumbnail);

                // Create the install button (t-install feature) if necessary
                const moduleID = $snippet.data('moduleId');
                if (moduleID) {
                    el.classList.add('o_snippet_install');
                    $thumbnail.append($('<button/>', {
                        class: 'btn btn-primary o_install_btn w-100',
                        type: 'button',
                        text: _t("Install"),
                    }));
                }

                // Create the delete button for custom snippets
                if (isCustomSnippet) {
                    const btnEl = document.createElement('we-button');
                    btnEl.dataset.snippetId = $snippet.data('oeSnippetId');
                    btnEl.classList.add('o_delete_btn', 'fa', 'fa-trash', 'btn', 'o_we_hover_danger');
                    btnEl.title = _.str.sprintf(_t("Delete %s"), name);
                    $snippet.append(btnEl);
                }
            })
            .not('[data-module-id]');

        // Hide scroll if no snippets defined
        if (!this.$snippets.length) {
            this.$el.detach();
        }

        // Register the text nodes that needs to be auto-selected on click
        this._registerDefaultTexts();

        // Force non editable part to contentEditable=false
        $html.find('.o_not_editable').attr('contentEditable', false);

        // Add the computed template and make elements draggable
        this.$el.html($html);
        this.$el.append(this.customizePanel);
        this.$el.append(this.textEditorPanelEl);
        this.$el.append(this.invisibleDOMPanelEl);
        this._makeSnippetDraggable(this.$snippets);
        this._disableUndroppableSnippets();

        this.$el.addClass('o_loaded');
        $('body.editor_enable').addClass('editor_has_snippets');
        this.trigger_up('snippets_loaded', self.$el);
    },
    /**
     * Creates a snippet editor to associated to the given snippet. If the given
     * snippet already has a linked snippet editor, the function only returns
     * that one.
     * The function also instantiates a snippet editor for all snippet parents
     * as a snippet editor must be able to display the parent snippet options.
     *
     * @private
     * @param {jQuery} $snippet
     * @returns {Promise<SnippetEditor>}
     */
    _createSnippetEditor: function ($snippet) {
        var self = this;
        var snippetEditor = $snippet.data('snippet-editor');
        if (snippetEditor) {
            return snippetEditor.__isStarted;
        }

        var def;
        var $parent = globalSelector.closest($snippet.parent());
        if ($parent.length) {
            def = this._createSnippetEditor($parent);
        }

        return Promise.resolve(def).then(function (parentEditor) {
            // When reaching this position, after the Promise resolution, the
            // snippet editor instance might have been created by another call
            // to _createSnippetEditor... the whole logic should be improved
            // to avoid doing this here.
            snippetEditor = $snippet.data('snippet-editor');
            if (snippetEditor) {
                return snippetEditor.__isStarted;
            }

            let editableArea = self.getEditableArea();
            snippetEditor = new SnippetEditor(parentEditor || self, $snippet, self.templateOptions, $snippet.closest('[data-oe-type="html"], .oe_structure').add(editableArea), self.options);
            self.snippetEditors.push(snippetEditor);
            return snippetEditor.appendTo(self.$snippetEditorArea);
        }).then(function () {
            return snippetEditor;
        });
    },
    /**
     * There may be no location where some snippets might be dropped. This mades
     * them appear disabled in the menu.
     *
     * @todo make them undraggable
     * @private
     */
    _disableUndroppableSnippets: function () {
        var self = this;
        var cache = {};
        this.$snippets.each(function () {
            var $snippet = $(this);
            var $snippetBody = $snippet.find('.oe_snippet_body');

            var check = false;
            _.each(self.templateOptions, function (option, k) {
                if (check || !($snippetBody.is(option.base_selector) && !$snippetBody.is(option.base_exclude))) {
                    return;
                }

                cache[k] = cache[k] || {
                    'drop-near': option['drop-near'] ? option['drop-near'].all().length : 0,
                    'drop-in': option['drop-in'] ? option['drop-in'].all().length : 0
                };
                check = (cache[k]['drop-near'] || cache[k]['drop-in']);
            });

            $snippet.toggleClass('o_disabled', !check);
            $snippet.attr('title', check ? '' : _t("No location to drop in"));
            const $icon = $snippet.find('.o_snippet_undroppable').remove();
            if (check) {
                $icon.remove();
            } else if (!$icon.length) {
                const imgEl = document.createElement('img');
                imgEl.classList.add('o_snippet_undroppable');
                imgEl.src = '/web_editor/static/src/img/snippet_disabled.svg';
                $snippet.append(imgEl);
            }
        });
    },
    /**
     * @private
     * @param {string} [search]
     */
    _filterSnippets(search) {
        const searchInputEl = this.el.querySelector('.o_snippet_search_filter_input');
        const searchInputReset = this.el.querySelector('.o_snippet_search_filter_reset');
        if (search !== undefined) {
            searchInputEl.value = search;
        } else {
            search = searchInputEl.value;
        }
        search = search.toLowerCase();
        searchInputReset.classList.toggle('d-none', !search);
        const strMatches = str => !search || str.toLowerCase().includes(search);
        for (const panelEl of this.el.querySelectorAll('.o_panel')) {
            let hasVisibleSnippet = false;
            const panelTitle = panelEl.querySelector('.o_panel_header').textContent;
            const isPanelTitleMatch = strMatches(panelTitle);
            for (const snippetEl of panelEl.querySelectorAll('.oe_snippet')) {
                const matches = (isPanelTitleMatch
                    || strMatches(snippetEl.getAttribute('name'))
                    || strMatches(snippetEl.dataset.oeKeywords || ''));
                if (matches) {
                    hasVisibleSnippet = true;
                }
                snippetEl.classList.toggle('d-none', !matches);
            }
            panelEl.classList.toggle('d-none', !hasVisibleSnippet);
        }
    },
    /**
     * @private
     * @param {Object} [options={}]
     * @returns {Object}
     */
    _getScrollOptions(options = {}) {
        return Object.assign({}, options, {
            scrollBoundaries: Object.assign({
                right: false,
            }, options.scrollBoundaries),
            jQueryDraggableOptions: Object.assign({
                appendTo: this.$body,
                cursor: 'move',
                greedy: true,
                scroll: false,
            }, options.jQueryDraggableOptions),
            disableHorizontalScroll: true,
        });
    },
    /**
     * Creates a dropzone element and inserts it by replacing the given jQuery
     * location. This allows to add data on the dropzone depending on the hook
     * environment.
     *
     * @private
     * @param {jQuery} $hook
     * @param {boolean} [vertical=false]
     * @param {Object} [style]
     */
    _insertDropzone: function ($hook, vertical, style) {
        var $dropzone = $('<div/>', {
            'class': 'oe_drop_zone oe_insert' + (vertical ? ' oe_vertical' : ''),
        });
        if (style) {
            $dropzone.css(style);
        }
        $hook.replaceWith($dropzone);
        return $dropzone;
    },
    /**
     * Make given snippets be draggable/droppable thanks to their thumbnail.
     *
     * @private
     * @param {jQuery} $snippets
     */
    _makeSnippetDraggable: function ($snippets) {
        var self = this;
        var $toInsert, dropped, $snippet;

        let dragAndDropResolve;
        const $scrollingElement = $().getScrollingElement();

        const smoothScrollOptions = this._getScrollOptions({
            jQueryDraggableOptions: {
                handle: '.oe_snippet_thumbnail:not(.o_we_already_dragging)',
                helper: function () {
                    const dragSnip = this.cloneNode(true);
                    dragSnip.querySelectorAll('.o_delete_btn').forEach(
                        el => el.remove()
                    );
                    return dragSnip;
                },
                start: function () {
                    const prom = new Promise(resolve => dragAndDropResolve = () => resolve());
                    self._mutex.exec(() => prom);

                    self.$el.find('.oe_snippet_thumbnail').addClass('o_we_already_dragging');

                    dropped = false;
                    $snippet = $(this);
                    var $baseBody = $snippet.find('.oe_snippet_body');
                    var $selectorSiblings = $();
                    var $selectorChildren = $();
                    var temp = self.templateOptions;
                    for (var k in temp) {
                        if ($baseBody.is(temp[k].base_selector) && !$baseBody.is(temp[k].base_exclude)) {
                            if (temp[k]['drop-near']) {
                                $selectorSiblings = $selectorSiblings.add(temp[k]['drop-near'].all());
                            }
                            if (temp[k]['drop-in']) {
                                $selectorChildren = $selectorChildren.add(temp[k]['drop-in'].all());
                            }
                        }
                    }

                    // TODO mentioning external app snippet but done as a stable fix
                    // that will be adapted in master: if popup snippet, do not
                    // allow to add it in another snippet
                    if ($baseBody[0].matches('.s_popup, .o_newsletter_popup')) {
                        $selectorChildren = $selectorChildren.not('[data-snippet] *');
                    }

                    $toInsert = $baseBody.clone();
                    // Color-customize dynamic SVGs in dropped snippets with current theme colors.
                    [...$toInsert.find('img[src^="/web_editor/shape/"]')].forEach(dynamicSvg => {
                        const colorCustomizedURL = new URL(dynamicSvg.getAttribute('src'), window.location.origin);
                        colorCustomizedURL.searchParams.set('c1', getCSSVariableValue('o-color-1'));
                        dynamicSvg.src = colorCustomizedURL.pathname + colorCustomizedURL.search;
                    });

                    if (!$selectorSiblings.length && !$selectorChildren.length) {
                        console.warn($snippet.find('.oe_snippet_thumbnail_title').text() + " have not insert action: data-drop-near or data-drop-in");
                        return;
                    }

                    self._activateInsertionZones($selectorSiblings, $selectorChildren);

                    self.getEditableArea().find('.oe_drop_zone').droppable({
                        over: function () {
                            if (dropped) {
                                $toInsert.detach();
                                $toInsert.addClass('oe_snippet_body');
                                $('.oe_drop_zone').removeClass('invisible');
                            }
                            dropped = true;
                            $(this).first().after($toInsert).addClass('invisible');
                            $toInsert.removeClass('oe_snippet_body');
                        },
                        out: function () {
                            var prev = $toInsert.prev();
                            if (this === prev[0]) {
                                dropped = false;
                                $toInsert.detach();
                                $(this).removeClass('invisible');
                                $toInsert.addClass('oe_snippet_body');
                            }
                        },
                    });

                    // If a modal is open, the scroll target must be that modal
                    const $openModal = self.getEditableArea().find('.modal:visible');
                    self.draggableComponent.$scrollTarget = $openModal.length ? $openModal : $scrollingElement;

                    // Trigger a scroll on the draggable element so that jQuery updates
                    // the position of the drop zones.
                    self.draggableComponent.$scrollTarget.on('scroll.scrolling_element', function () {
                        self.$el.trigger('scroll');
                    });
                },
                stop: async function (ev, ui) {
                    $toInsert.removeClass('oe_snippet_body');
                    self.draggableComponent.$scrollTarget.off('scroll.scrolling_element');

                    if (!dropped && ui.position.top > 3 && ui.position.left + ui.helper.outerHeight() < self.el.getBoundingClientRect().left) {
                        var $el = $.nearest({x: ui.position.left, y: ui.position.top}, '.oe_drop_zone', {container: document.body}).first();
                        if ($el.length) {
                            $el.after($toInsert);
                            dropped = true;
                        }
                    }

                    self.getEditableArea().find('.oe_drop_zone').droppable('destroy').remove();

                    if (dropped) {
                        var prev = $toInsert.first()[0].previousSibling;
                        var next = $toInsert.last()[0].nextSibling;

                        if (prev) {
                            $toInsert.detach();
                            self.trigger_up('request_history_undo_record', {$target: $(prev)});
                            $toInsert.insertAfter(prev);
                        } else if (next) {
                            $toInsert.detach();
                            self.trigger_up('request_history_undo_record', {$target: $(next)});
                            $toInsert.insertBefore(next);
                        } else {
                            var $parent = $toInsert.parent();
                            $toInsert.detach();
                            self.trigger_up('request_history_undo_record', {$target: $parent});
                            $parent.prepend($toInsert);
                        }

                        var $target = $toInsert;
                        await self._scrollToSnippet($target);

                        _.defer(async function () {
                            self.trigger_up('snippet_dropped', {$target: $target});
                            self._disableUndroppableSnippets();

                            dragAndDropResolve();

                            await self._callForEachChildSnippet($target, function (editor, $snippet) {
                                return editor.buildSnippet();
                            });
                            $target.trigger('content_changed');
                            await self._updateInvisibleDOM();

                            self.$el.find('.oe_snippet_thumbnail').removeClass('o_we_already_dragging');
                        });
                    } else {
                        $toInsert.remove();
                        dragAndDropResolve();
                        self.$el.find('.oe_snippet_thumbnail').removeClass('o_we_already_dragging');
                    }
                },
            },
        });
        this.draggableComponent = new SmoothScrollOnDrag(this, $snippets, $scrollingElement, smoothScrollOptions);
    },
    /**
     * Adds the 'o_default_snippet_text' class on nodes which contain only
     * non-empty text nodes. Those nodes are then auto-selected by the editor
     * when they are clicked.
     *
     * @private
     * @param {jQuery} [$in] - the element in which to search, default to the
     *                       snippet bodies in the menu
     */
    _registerDefaultTexts: function ($in) {
        if ($in === undefined) {
            $in = this.$snippets.find('.oe_snippet_body');
        }

        $in.find('*').addBack()
            .contents()
            .filter(function () {
                return this.nodeType === 3 && this.textContent.match(/\S/);
            }).parent().addClass('o_default_snippet_text');
    },
    /**
     * Changes the content of the left panel and selects a tab.
     *
     * @private
     * @param {htmlString | Element | Text | Array | jQuery} [content]
     * the new content of the customizePanel
     * @param {this.tabs.VALUE} [tab='blocks'] - the tab to select
     */
    _updateLeftPanelContent: function ({content, tab}) {
        clearTimeout(this._textToolsSwitchingTimeout);
        this._closeWidgets();

        tab = tab || this.tabs.BLOCKS;

        if (content) {
            while (this.customizePanel.firstChild) {
                this.customizePanel.removeChild(this.customizePanel.firstChild);
            }
            $(this.customizePanel).append(content);
        }

        this.$('.o_snippet_search_filter').toggleClass('d-none', tab !== this.tabs.BLOCKS);
        this.$('#o_scroll').toggleClass('d-none', tab !== this.tabs.BLOCKS);
        this.customizePanel.classList.toggle('d-none', tab === this.tabs.BLOCKS);
        this.textEditorPanelEl.classList.toggle('d-none', tab !== this.tabs.OPTIONS);

        this.$('.o_we_add_snippet_btn').toggleClass('active', tab === this.tabs.BLOCKS);
        this.$('.o_we_customize_snippet_btn').toggleClass('active', tab === this.tabs.OPTIONS)
                                             .prop('disabled', tab !== this.tabs.OPTIONS);

    },
    /**
     * Scrolls to given snippet.
     *
     * @private
     * @param {jQuery} $el - snippet to scroll to
     * @return {Promise}
     */
    async _scrollToSnippet($el) {
        return dom.scrollTo($el[0], {extraOffset: 50});
    },
    /**
     * @private
     * @returns {HTMLElement}
     */
    _createLoadingElement() {
        const loaderContainer = document.createElement('div');
        const loader = document.createElement('i');
        const loaderContainerClassList = [
            'o_we_ui_loading',
            'd-flex',
            'justify-content-center',
            'align-items-center',
        ];
        const loaderClassList = [
            'fa',
            'fa-circle-o-notch',
            'fa-spin',
            'fa-4x',
        ];
        loaderContainer.classList.add(...loaderContainerClassList);
        loader.classList.add(...loaderClassList);
        loaderContainer.appendChild(loader);
        return loaderContainer;
    },
    /**
     * Adds the action to the mutex queue and sets a loading effect over the
     * editor to appear if the action takes too much time.
     * As soon as the mutex is unlocked, the loading effect will be removed.
     *
     * @private
     * @param {function} action
     * @param {boolean} [contentLoading=true]
     * @param {number} [delay=500]
     * @returns {Promise}
     */
    async _execWithLoadingEffect(action, contentLoading = true, delay = 500) {
        const mutexExecResult = this._mutex.exec(action);
        if (!this.loadingTimers[contentLoading]) {
            const addLoader = () => {
                if (this.loadingElements[contentLoading]) {
                    return;
                }
                this.loadingElements[contentLoading] = this._createLoadingElement();
                if (contentLoading) {
                    this.$snippetEditorArea.append(this.loadingElements[contentLoading]);
                } else {
                    this.el.appendChild(this.loadingElements[contentLoading]);
                }
            };
            if (delay) {
                this.loadingTimers[contentLoading] = setTimeout(addLoader, delay);
            } else {
                addLoader();
            }
            this._mutex.getUnlockedDef().then(() => {
                // Note: we remove the loading element at the end of the
                // execution queue *even if subsequent actions are content
                // related or not*. This is a limitation of the loading feature,
                // the goal is still to limit the number of elements in that
                // queue anyway.
                if (delay) {
                    clearTimeout(this.loadingTimers[contentLoading]);
                    this.loadingTimers[contentLoading] = undefined;
                }

                if (this.loadingElements[contentLoading]) {
                    this.loadingElements[contentLoading].remove();
                    this.loadingElements[contentLoading] = null;
                }
            });
        }
        return mutexExecResult;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Called when a child editor asks for insertion zones to be enabled.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onActivateInsertionZones: function (ev) {
        this._activateInsertionZones(ev.data.$selectorSiblings, ev.data.$selectorChildren);
    },
    /**
     * Called when a child editor asks to deactivate the current snippet
     * overlay.
     *
     * @private
     */
    _onActivateSnippet: function (ev) {
        this._activateSnippet(ev.data.$snippet, ev.data.previewMode, ev.data.ifInactiveOptions);
    },
    /**
     * Called when a child editor asks to operate some operation on all child
     * snippet of a DOM element.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onCallForEachChildSnippet: function (ev) {
        const prom = this._callForEachChildSnippet(ev.data.$snippet, ev.data.callback);
        if (ev.data.onSuccess) {
            prom.then(() => ev.data.onSuccess());
        }
    },
    /**
     * Called when the overlay dimensions/positions should be recomputed.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onOverlaysCoverUpdate: function (ev) {
        this.snippetEditors.forEach(editor => {
            if (ev.data.overlayVisible) {
                editor.toggleOverlayVisibility(true);
            }
            editor.cover();
        });
    },
    /**
     * Called when a child editor asks to clone a snippet, allows to correctly
     * call the _onClone methods if the element's editor has one.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onCloneSnippet: async function (ev) {
        ev.stopPropagation();
        const editor = await this._createSnippetEditor(ev.data.$snippet);
        await editor.clone();
        if (ev.data.onSuccess) {
            ev.data.onSuccess();
        }
    },
    /**
     * Called when a child editor asks to deactivate the current snippet
     * overlay.
     *
     * @private
     */
    _onDeactivateSnippet: function () {
        this._activateSnippet(false);
    },
    /**
     * Called when a snippet has moved in the page.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onDragAndDropStop: async function (ev) {
        const $modal = ev.data.$snippet.closest('.modal');
        // If the snippet is in a modal, destroy editors only in that modal.
        // This to prevent the modal from closing because of the cleanForSave
        // on each editors.
        await this._destroyEditors($modal.length ? $modal : null);
        await this._activateSnippet(ev.data.$snippet);
    },
    /**
     * Called when a snippet editor asked to disable itself and to enable its
     * parent instead.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onGoToParent: function (ev) {
        ev.stopPropagation();
        this._activateSnippet(ev.data.$snippet.parent());
    },
    /**
     * @private
     */
    _onHideOverlay: function () {
        for (const editor of this.snippetEditors) {
            editor.toggleOverlay(false);
        }
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onInstallBtnClick: function (ev) {
        var self = this;
        var $snippet = $(ev.currentTarget).closest('[data-module-id]');
        var moduleID = $snippet.data('moduleId');
        var name = $snippet.attr('name');
        new Dialog(this, {
            title: _.str.sprintf(_t("Install %s"), name),
            size: 'medium',
            $content: $('<div/>', {text: _.str.sprintf(_t("Do you want to install the %s App?"), name)}).append(
                $('<a/>', {
                    target: '_blank',
                    href: '/web#id=' + moduleID + '&view_type=form&model=ir.module.module&action=base.open_module_tree',
                    text: _t("More info about this app."),
                    class: 'ml4',
                })
            ),
            buttons: [{
                text: _t("Save and Install"),
                classes: 'btn-primary',
                click: function () {
                    this.$footer.find('.btn').toggleClass('o_hidden');
                    this._rpc({
                        model: 'ir.module.module',
                        method: 'button_immediate_install',
                        args: [[moduleID]],
                    }).then(() => {
                        self.trigger_up('request_save', {
                            reloadEditor: true,
                            _toMutex: true,
                        });
                    }).guardedCatch(reason => {
                        reason.event.preventDefault();
                        this.close();
                        self.displayNotification({
                            message: _.str.sprintf(_t("Could not install module <strong>%s</strong>"), name),
                            type: 'danger',
                            sticky: true,
                        });
                    });
                },
            }, {
                text: _t("Install in progress"),
                icon: 'fa-spin fa-spinner fa-pulse mr8',
                classes: 'btn-primary disabled o_hidden',
            }, {
                text: _t("Cancel"),
                close: true,
            }],
        }).open();
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onInvisibleEntryClick: async function (ev) {
        ev.preventDefault();
        const $snippet = $(this.invisibleDOMMap.get(ev.currentTarget));
        const isVisible = await this._execWithLoadingEffect(async () => {
            const editor = await this._createSnippetEditor($snippet);
            return editor.toggleTargetVisibility();
        }, true);
        $(ev.currentTarget).find('.fa')
            .toggleClass('fa-eye', isVisible)
            .toggleClass('fa-eye-slash', !isVisible);
        return this._activateSnippet(isVisible ? $snippet : false);
    },
    /**
     * @private
     */
    _onBlocksTabClick: function (ev) {
        this._activateSnippet(false).then(() => {
            this._updateLeftPanelContent({
                content: [],
                tab: this.tabs.BLOCKS,
            });
        });
    },
    /**
     * @private
     */
    _onDeleteBtnClick: function (ev) {
        const $snippet = $(ev.target).closest('.oe_snippet');
        const snippetId = parseInt(ev.currentTarget.dataset.snippetId);
        ev.stopPropagation();
        new Dialog(this, {
            size: 'medium',
            title: _t('Confirmation'),
            $content: $('<div><p>' + _.str.sprintf(_t("Are you sure you want to delete the snippet: %s ?"), $snippet.attr('name')) + '</p></div>'),
            buttons: [{
                text: _t("Yes"),
                close: true,
                classes: 'btn-primary',
                click: async () => {
                    await this._rpc({
                        model: 'ir.ui.view',
                        method: 'delete_snippet',
                        kwargs: {
                            'view_id': snippetId,
                            'template_key': this.options.snippets,
                        },
                    });
                    await this._loadSnippetsTemplates(true);
                },
            }, {
                text: _t("No"),
                close: true,
            }],
        }).open();
    },
    /**
     * Prevents pointer-events to change the focus when a pointer slide from
     * left-panel to the editable area.
     *
     * @private
     */
    _onMouseDown: function () {
        const $blockedArea = $('#wrapwrap'); // TODO should get that element another way
        $blockedArea.addClass('o_we_no_pointer_events');
        const reenable = () => $blockedArea.removeClass('o_we_no_pointer_events');
        // Use a setTimeout fallback to avoid locking the editor if the mouseup
        // is fired over an element which stops propagation for example.
        const enableTimeoutID = setTimeout(() => reenable(), 5000);
        $(document).one('mouseup', () => {
            clearTimeout(enableTimeoutID);
            reenable();
        });
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onGetSnippetVersions: function (ev) {
        const snippet = this.el.querySelector(`.oe_snippet > [data-snippet="${ev.data.snippetName}"]`);
        ev.data.onSuccess(snippet && {
            vcss: snippet.dataset.vcss,
            vjs: snippet.dataset.vjs,
            vxml: snippet.dataset.vxml,
        });
    },
    /**
     * UNUSED: used to be called when saving a custom snippet. We now save and
     * reload the page when saving a custom snippet so that all the DOM cleanup
     * mechanisms are run before saving. Kept for compatibility.
     *
     * TODO: remove in master / find a way to clean the DOM without save+reload
     *
     * @private
     */
    _onReloadSnippetTemplate: async function (ev) {
        await this._activateSnippet(false);
        await this._loadSnippetsTemplates(true);
    },
    /**
     * @private
     */
    _onBlockPreviewOverlays: function (ev) {
        this._blockPreviewOverlays = true;
    },
    /**
     * @private
     */
    _onUnblockPreviewOverlays: function (ev) {
        this._blockPreviewOverlays = false;
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onRemoveSnippet: async function (ev) {
        ev.stopPropagation();
        const editor = await this._createSnippetEditor(ev.data.$snippet);
        await editor.removeSnippet();
        if (ev.data.onSuccess) {
            ev.data.onSuccess();
        }
    },
    /**
     * Saving will destroy all editors since they need to clean their DOM.
     * This has thus to be done when they are all finished doing their work.
     *
     * @private
     */
    _onSaveRequest: function (ev) {
        const data = ev.data;
        if (ev.target === this && !data._toMutex) {
            return;
        }
        delete data._toMutex;
        ev.stopPropagation();
        this._execWithLoadingEffect(() => {
            if (data.reloadEditor) {
                data.reload = false;
                const oldOnSuccess = data.onSuccess;
                data.onSuccess = async function () {
                    if (oldOnSuccess) {
                        await oldOnSuccess.call(this, ...arguments);
                    }
                    window.location.href = window.location.origin + window.location.pathname + '?enable_editor=1';
                };
            }
            this.trigger_up('request_save', data);
        }, true);
    },
    /**
     * @private
     */
    _onSnippetClick() {
        const $els = this.getEditableArea().find('.oe_structure.oe_empty').addBack('.oe_structure.oe_empty');
        for (const el of $els) {
            if (!el.children.length) {
                $(el).odooBounce('o_we_snippet_area_animation');
            }
        }
    },
    /**
     * @private
     * @param {OdooEvent} ev
     * @param {Object} ev.data
     * @param {function} ev.data.exec
     */
    _onSnippetEditionRequest: function (ev) {
        this._execWithLoadingEffect(ev.data.exec, true);
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onSnippetEditorDestroyed(ev) {
        ev.stopPropagation();
        const index = this.snippetEditors.indexOf(ev.target);
        this.snippetEditors.splice(index, 1);
    },
    /**
     * @private
     */
    _onSnippetCloned: function (ev) {
        this._updateInvisibleDOM();
    },
    /**
     * Called when a snippet is removed -> checks if there is draggable snippets
     * to enable/disable as the DOM changed.
     *
     * @private
     */
    _onSnippetRemoved: function () {
        this._disableUndroppableSnippets();
        this._updateInvisibleDOM();
    },
    /**
     * When the editor panel receives a notification indicating that an option
     * was used, the panel is in charge of asking for an UI update of the whole
     * panel. Logically, the options are displayed so that an option above
     * may influence the status and visibility of an option which is below;
     * e.g.:
     * - the user sets a badge type to 'info'
     *      -> the badge background option (below) is shown as blue
     * - the user adds a shadow
     *      -> more options are shown afterwards to control it (not above)
     *
     * Technically we however update the whole editor panel (parent and child
     * options) wherever the updates comes from. The only important thing is
     * to first update the options UI then their visibility as their visibility
     * may depend on their UI status.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onSnippetOptionUpdate(ev) {
        ev.stopPropagation();
        (async () => {
            const editors = this._enabledEditorHierarchy;
            await Promise.all(editors.map(editor => editor.updateOptionsUI()));
            await Promise.all(editors.map(editor => editor.updateOptionsUIVisibility()));
            ev.data.onSuccess();
        })();
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onSnippetOptionVisibilityUpdate: async function (ev) {
        if (!ev.data.show) {
            await this._activateSnippet(false);
        }
        await this._updateInvisibleDOM(); // Re-render to update status
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onSnippetThumbnailURLRequest(ev) {
        const $snippet = this.$snippets.has(`[data-snippet="${ev.data.key}"]`);
        ev.data.onSuccess($snippet.length ? $snippet[0].dataset.oeThumbnail : '');
    },
    /**
     * @private
     */
    _onSummernoteToolsUpdate(ev) {
        if (!this._textToolsSwitchingEnabled) {
            return;
        }
        const range = $.summernote.core.range.create();
        if (!range) {
            return;
        }
        if (range.sc === range.ec && range.sc.nodeType === Node.ELEMENT_NODE
                && range.sc.classList.contains('oe_structure')
                && range.sc.children.length === 0) {
            // Do not switch to text tools if the cursor is in an empty
            // oe_structure (to encourage using snippets there and actually
            // avoid breaking tours which suppose the snippet list is visible).
            return;
        }
        this.textEditorPanelEl.classList.add('d-block');
        const hasVisibleButtons = !!$(this.textEditorPanelEl).find('.btn:visible').length;
        this.textEditorPanelEl.classList.remove('d-block');
        if (!hasVisibleButtons) {
            // Ugly way to detect that summernote was updated but there is no
            // visible text tools.
            return;
        }
        // Only switch tab without changing content (_updateLeftPanelContent
        // make text tools visible only on that specific tab). Also do it with
        // a slight delay to avoid flickering doing it twice.
        clearTimeout(this._textToolsSwitchingTimeout);
        if (!this.$('#o_scroll').hasClass('d-none')) {
            this._textToolsSwitchingTimeout = setTimeout(() => {
                this._updateLeftPanelContent({tab: this.tabs.OPTIONS});
            }, 250);
        }
    },
    /**
     * @private
     * @param {OdooEvent} ev
     */
    _onUpdateCustomizeElements: function (ev) {
        this._updateLeftPanelContent({
            content: ev.data.customize$Elements,
            tab: ev.data.customize$Elements.length ? this.tabs.OPTIONS : this.tabs.BLOCKS,
        });
    },
    /**
     * Called when an user value widget is being opened -> close all the other
     * user value widgets of all editors + add backdrop.
     */
    _onUserValueWidgetOpening: function () {
        this._closeWidgets();
        this.el.classList.add('o_we_backdrop');
    },
    /**
     * Called when an user value widget is being closed -> rely on the fact only
     * one widget can be opened at a time: remove the backdrop.
     */
    _onUserValueWidgetClosing: function () {
        this.el.classList.remove('o_we_backdrop');
    },
    /**
     * Called when search input value changed -> adapts the snippets grid.
     *
     * @private
     */
    _onSnippetSearchInput: function () {
        this._filterSnippets();
    },
    /**
     * Called on snippet search filter reset -> clear input field search.
     *
     * @private
     */
    _onSnippetSearchResetClick: function () {
        this._filterSnippets('');
    },
});

return {
    Class: SnippetsMenu,
    Editor: SnippetEditor,
    globalSelector: globalSelector,
};
});
