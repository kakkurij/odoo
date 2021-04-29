
from odoo import fields, models


class FilePick(models.TransientModel):
    _name="stock.filepicking"
    _description="Pick from file"
    
    name = fields.Char(
        'Reference', default='Filename')
    
    
  