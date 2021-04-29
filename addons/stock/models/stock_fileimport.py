
from odoo import fields, models, api

import base64
import pandas as pd
import io

class FileReader(models.TransientModel):
    _name="stock.filereader"
    _description="Reads stock moves from file"
    
    file = fields.Binary(string="File")
    filename = fields.Char(string="File Name")
    
    def create_picking_from_file(self):
        
        ids = self.env.context.get('active_ids', [])
        picking_rec = self.env['stock.picking'].browse(ids)
        
        # Decrypting to base64
        decrypted = base64.b64decode(self.file)
        to_read = io.BytesIO()
        to_read.write(decrypted)
        to_read.seek(0)
        df = pd.read_excel(to_read)
        print(df)
        
        for i, row in df.iterrows():
            
            product_code = row['tuotekoodi']
        
            product = self.env['product.product'].search([['default_code', '=', product_code]])
            product_uom_qty = row['maara']
            uom_name = row['yksikko']
            uom = self.env['uom.uom'].search([['name', '=', uom_name]]).id # Jotain tästä se huutaa...

            
            picking_rec.write({"move_ids_without_package": [
                        [
                            0,
                            0,
                            {
                                "company_id": 1, # Default
                                "name": f"[{product_code}] {product.name}",
                                "state": "draft",
                                "picking_type_id": picking_rec.picking_type_id, # sequence_code = PICK
                                
                                "product_id": product.id,
                                "description_picking": "Excel-tiedoston siirto",
                                "location_id": picking_rec.location_id, # Vendors location
                                "location_dest_id": 5, # Default to Customers location
                                "product_uom_qty": product_uom_qty,
                                "product_uom": uom,
                            },
                        ]
            ]})
            
            