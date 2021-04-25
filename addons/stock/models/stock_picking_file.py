from odoo import fields, models, api

class ExcelPicking(models.TransientModel):
    _name = "stock.picking.file"
    _description = "Pick from file"
    
    
    origin = fields.Char('Source document')
    state = fields.Selection([('draft', 'Draft'),
        ('waiting', 'Waiting Another Operation'),
        ('confirmed', 'Waiting'),
        ('assigned', 'Ready'),
        ('done', 'Done'),
        ('cancel', 'Cancelled')])
    
    date = fields.Datetime(
        'Creation Date',
        default=fields.Datetime.now, index=True,
        states={'done': [('readonly', True)], 'cancel': [('readonly', True)]},
        help="Creation Date, usually the time of the order")
    
    scheduled_date = fields.Datetime(
        'Scheduled Date', compute='_compute_scheduled_date', inverse='_set_scheduled_date', store=True,
        index=True, default=fields.Datetime.now,
        states={'done': [('readonly', True)], 'cancel': [('readonly', True)]},
        help="Scheduled time for the first part of the shipment to be processed. Setting manually a value here would set it as expected date for all the stock moves.")
    
   
    
    picking_type_id = fields.Many2one(
        'stock.picking.type', 'Operation Type',
        required=True, readonly=True,
        states={'draft': [('readonly', False)]})
    
    company_id = fields.Many2one(
        'res.company', string='Company', related='picking_type_id.company_id',
        readonly=True, store=True, index=True)
    
    partner_id = fields.Many2one(
        'res.partner', 'Contact',
        states={'done': [('readonly', True)], 'cancel': [('readonly', True)]})
    company_id = fields.Many2one(
        'res.company', string='Company', related='picking_type_id.company_id',
        readonly=True, store=True, index=True)
    
    picking_type_id = fields.Many2one(
        'stock.picking.type', 'Operation Type',
        required=True, readonly=True,
        states={'draft': [('readonly', False)]})
    
    project_id = fields.Many2one(
        'project.project', "Projekti",
        domain=[('project_type', '=', 'projektit')])

    main_cost_center_id = fields.Many2one(
        'project.project', "Pääkustannuspaikka",
        domain=[('project_type', '!=', 'projektit')])
    
    json_popover = fields.Char(
        'JSON data for the popover widget', compute='_compute_json_popover')
    
    file = fields.Binary(string="File")
    
    
    def _compute_json_popover(self):
        for picking in self:
            if picking.state in ('done', 'cancel') or not picking.delay_alert_date:
                picking.json_popover = False
                continue
            picking.json_popover = json.dumps({
                'popoverTemplate': 'stock.PopoverStockRescheduling',
                'delay_alert_date': format_datetime(self.env, picking.delay_alert_date, dt_format=False) if picking.delay_alert_date else False,
                'late_elements': [{
                    'id': late_move.id,
                    'name': late_move.display_name,
                    'model': late_move._name,
                } for late_move in picking.move_lines.filtered(lambda m: m.delay_alert_date).move_orig_ids._delay_alert_get_documents()
                ]
            })
